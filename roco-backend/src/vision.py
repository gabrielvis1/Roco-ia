"""Módulo de procesamiento de visión computacional local para Roco.

Contiene el pipeline de ingesta de video (DXcam y OpenCV), el cargador e
inferenciador de YOLOv11-nano en ONNX Runtime, y el motor de OCR (EasyOCR)
con filtrado de duplicados por hash perceptivo y MSE.
"""

import asyncio
import hashlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast, Any, Callable, Dict, List, Optional, Tuple

import mss
import pygetwindow as gw
import cv2
import dxcam
import imagehash
import numpy as np
from loguru import logger
from PIL import Image

try:
    import onnxruntime as ort
except ImportError:
    ort = None

try:
    import easyocr
except ImportError:
    easyocr = None


class VideoIngester:
    """Clase encargada de capturar video a 10 FPS de forma optimizada.

    Soporta captura por software (DXcam) y por hardware (OpenCV DirectShow/MF).
    """

    def __init__(self, source_type: str, target_id: str) -> None:
        """Inicializa la fuente de captura de video.

        Args:
            source_type: 'monitor', 'window' o 'camera'.
            target_id: ID físico o lógico de la fuente.
        """
        self.source_type = source_type
        self.target_id = target_id
        self.dx_camera: Optional[Any] = None
        self.cv_cap: Optional[cv2.VideoCapture] = None
        self.sct: Optional[Any] = None
        self._init_source()

    def _init_source(self) -> None:
        """Inicializa la cámara o capturadora física/lógica."""
        try:
            if self.source_type == "monitor":
                try:
                    idx = int(self.target_id)
                    self.dx_camera = dxcam.create(device_idx=idx)
                    logger.info(f"DXcam inicializado en el monitor index {idx}")
                except Exception as ex:
                    logger.warning(f"No se pudo iniciar DXcam, se usará mss como fallback: {ex}")
                self.sct = mss.mss()
            elif self.source_type == "window":
                self.sct = mss.mss()
                logger.info(f"Capturador de ventana MSS inicializado para {self.target_id}")
            elif self.source_type == "camera":
                idx = int(self.target_id)
                backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
                
                # Reintento 1: 1080p MJPG
                self.cv_cap = cv2.VideoCapture(idx, backend)
                if self.cv_cap.isOpened():
                    self.cv_cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))  # type: ignore
                    self.cv_cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
                    self.cv_cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
                    ret, test_frame = self.cv_cap.read()
                    if ret and test_frame is not None:
                        logger.info(f"OpenCV DirectShow inicializado para cámara {idx} en 1080p (MJPG)")
                        return
                    self.cv_cap.release()

                # Reintento 2: 720p MJPG
                self.cv_cap = cv2.VideoCapture(idx, backend)
                if self.cv_cap.isOpened():
                    self.cv_cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))  # type: ignore
                    self.cv_cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                    self.cv_cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    ret, test_frame = self.cv_cap.read()
                    if ret and test_frame is not None:
                        logger.info(f"OpenCV DirectShow inicializado para cámara {idx} en 720p (MJPG)")
                        return
                    self.cv_cap.release()

                # Reintento 3: Resoluciones por defecto (Driver Default)
                self.cv_cap = cv2.VideoCapture(idx, backend)
                if self.cv_cap.isOpened():
                    ret, test_frame = self.cv_cap.read()
                    if ret and test_frame is not None:
                        logger.info(f"OpenCV DirectShow inicializado para cámara {idx} con resolución por defecto")
                        return
                    logger.warning(f"Cámara {idx} abierta pero no se pudo leer ningún frame")
                else:
                    logger.warning(f"No se pudo abrir la cámara index {idx} con OpenCV")
        except Exception as e:
            logger.error(f"Fallo al inicializar la ingesta de video: {e}")

    def capture_frame(self) -> Optional[np.ndarray]:
        """Captura un frame individual de la fuente activa.

        Returns:
            Frame en formato BGR numpy o None si falla.
        """
        try:
            if self.source_type == "monitor":
                if self.dx_camera:
                    frame = self.dx_camera.grab()
                    if frame is not None:
                        return cast(np.ndarray, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
                
                # Fallback de mss
                if self.sct:
                    idx = int(self.target_id)
                    if idx < len(self.sct.monitors):
                        mon = self.sct.monitors[idx]
                        img = self.sct.grab(mon)
                        raw_frame = np.array(img)
                        return cast(np.ndarray, cv2.cvtColor(raw_frame, cv2.COLOR_BGRA2BGR))

            elif self.source_type == "window" and self.sct:
                win = None
                all_wins = gw.getAllWindows()
                try:
                    win = all_wins[int(self.target_id)]
                except ValueError:
                    for w in all_wins:
                        if w.title == self.target_id:
                            win = w
                            break
                if win:
                    l, t, w_width, w_height = win.left, win.top, win.width, win.height
                    if w_width > 0 and w_height > 0:
                        bbox = {"left": l, "top": t, "width": w_width, "height": w_height}
                        img = self.sct.grab(bbox)
                        raw_frame = np.array(img)
                        return cast(np.ndarray, cv2.cvtColor(raw_frame, cv2.COLOR_BGRA2BGR))

            elif self.source_type == "camera" and self.cv_cap:
                ret, frame = self.cv_cap.read()
                if ret:
                    return frame
        except Exception as e:
            logger.error(f"Error durante la captura del frame: {e}")
        return None

    def release(self) -> None:
        """Libera los recursos de hardware y software asociados."""
        if self.cv_cap:
            self.cv_cap.release()
            self.cv_cap = None
        if self.dx_camera:
            del self.dx_camera
            self.dx_camera = None
        if self.sct:
            self.sct.close()
            self.sct = None
        logger.info("Recursos de VideoIngester liberados.")


class YOLOSegmenter:
    """Clase para ejecutar inferencia YOLOv11-nano en ONNX Runtime.

    Detecta de forma eficiente 'dialog_box' (ID 0) y 'avatar' (ID 1).
    """

    def __init__(self, model_path: Optional[Path] = None) -> None:
        """Carga el modelo ONNX en memoria."""
        if model_path is None:
            model_path = Path(__file__).resolve().parent.parent / "models" / "yolov11n.onnx"

        self.session: Optional[ort.InferenceSession] = None
        if ort is None:
            logger.error("onnxruntime no está instalado en el entorno.")
            return

        try:
            if model_path.exists():
                # Forzar el uso de CPU o DirectML si está disponible
                providers = ["CPUExecutionProvider"]
                self.session = ort.InferenceSession(str(model_path), providers=providers)
                logger.success(f"YOLOv11-nano cargado exitosamente desde {model_path}")
            else:
                logger.warning(f"Archivo YOLOv11-nano no encontrado en {model_path}. Se usará modo simulado.")
        except Exception as e:
            logger.error(f"Falla crítica al cargar el modelo YOLOv11 ONNX: {e}")

    def detect(self, frame: np.ndarray) -> List[Dict[str, Any]]:
        """Realiza la inferencia YOLO sobre el frame.

        Args:
            frame: Imagen cruda BGR.

        Returns:
            Lista de detecciones con clase, confianza y bounding boxes relativas (0 a 1).
        """
        h, w = frame.shape[:2]
        if self.session is None:
            # Simulación: Devolver una caja de diálogo ficticia en el tercio inferior
            return [{
                "class": "dialog_box",
                "bbox": {"x1": 0.15, "y1": 0.70, "x2": 0.85, "y2": 0.88},
                "confidence": 0.90,
                "saved_zone_match": False
            }]

        try:
            # Preprocesamiento YOLO: Redimensionar a 640x640 y normalizar
            resized = cv2.resize(frame, (640, 640))
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
            blob = rgb.astype(np.float32) / 255.0
            blob = np.transpose(blob, (2, 0, 1))  # HWC -> CHW
            blob = np.expand_dims(blob, axis=0)   # CHW -> BCHW

            input_name = self.session.get_inputs()[0].name
            outputs = self.session.run(None, {input_name: blob})
            output = outputs[0]  # Shape: (1, 6, 8400) - cx, cy, nw, nh, score0, score1

            predictions = output[0]  # (6, 8400)
            boxes = []
            confidences = []
            class_ids = []

            for i in range(predictions.shape[1]):
                col = predictions[:, i]
                scores = col[4:]
                class_id = np.argmax(scores)
                score = scores[class_id]

                if score > 0.30:  # Umbral de detección
                    cx, cy, nw, nh = col[0], col[1], col[2], col[3]
                    # Convertir a esquinas relativas (0.0 a 1.0)
                    x1 = (cx - nw / 2.0) / 640.0
                    y1 = (cy - nh / 2.0) / 640.0
                    x2 = (cx + nw / 2.0) / 640.0
                    y2 = (cy + nh / 2.0) / 640.0

                    boxes.append([
                        max(0.0, min(1.0, float(x1))),
                        max(0.0, min(1.0, float(y1))),
                        max(0.0, min(1.0, float(x2))),
                        max(0.0, min(1.0, float(y2)))
                    ])
                    confidences.append(float(score))
                    class_ids.append(int(class_id))

            # Aplicar Non-Maximum Suppression (NMS)
            indices = cv2.dnn.NMSBoxes(
                [[int(b[0]*w), int(b[1]*h), int((b[2]-b[0])*w), int((b[3]-b[1])*h)] for b in boxes],
                confidences,
                score_threshold=0.30,
                nms_threshold=0.45
            )

            detections = []
            if len(indices) > 0:
                for idx in list(indices):
                    x1, y1, x2, y2 = boxes[idx]
                    class_name = "dialog_box" if class_ids[idx] == 0 else "avatar"
                    detections.append({
                        "class": class_name,
                        "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                        "confidence": confidences[idx]
                    })
            return detections
        except Exception as e:
            logger.error(f"Error durante inferencia YOLO ONNX: {e}")
            return []


class OCREngine:
    """Motor de OCR local basado en EasyOCR con preprocesamiento avanzado."""

    def __init__(self) -> None:
        """Inicializa el modelo de EasyOCR para español e inglés."""
        self.reader: Optional[easyocr.Reader] = None
        if easyocr is None:
            logger.error("easyocr no está instalado en el entorno.")
            return

        try:
            self.reader = easyocr.Reader(["es", "en"], gpu=True)
            logger.success("EasyOCR inicializado exitosamente (GPU habilitada si está disponible)")
        except Exception as e:
            logger.error(f"Falla al cargar EasyOCR: {e}")

    def preprocess_image(self, roi: np.ndarray) -> np.ndarray:
        """Aplica preprocesamiento avanzado (escala de grises, filtro bilateral, Otsu y auto-inversión).

        Args:
            roi: Imagen BGR de la región de interés.

        Returns:
            Imagen binarizada limpia en escala de grises.
        """
        try:
            # 1. Conversión a escala de grises estricta
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            
            # 2. Filtro bilateral para suavizar texturas de fondo y preservar bordes de texto
            filtered = cv2.bilateralFilter(gray, 9, 75, 75)
            
            # 3. Redimensionar al doble (2x) si la ROI es pequeña (ancho < 300 o alto < 100)
            h, w = roi.shape[:2]
            if w < 300 or h < 100:
                filtered = cv2.resize(filtered, (0, 0), fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
            
            # 4. Umbralización adaptativa o método de Otsu para forzar blanco sobre negro absoluto
            _, binary = cv2.threshold(filtered, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            
            # 5. Si el fondo es predominantemente blanco, invertir la imagen para tener texto blanco sobre negro
            if np.mean(binary) > 127:
                binary = cv2.bitwise_not(binary)
                
            return binary
        except Exception as e:
            logger.error(f"Fallo en preprocesamiento de imagen OCR: {e}")
            return roi

    def extract_text(self, roi: np.ndarray) -> Tuple[str, float]:
        """Ejecuta OCR sobre la región de interés preprocesada.

        Args:
            roi: Imagen BGR de la ROI.

        Returns:
            Tupla (texto_extraído, confianza).
        """
        if self.reader is None:
            return "EasyOCR no inicializado (Simulado: ¡Melina ofrece pacto!)", 0.90

        try:
            processed = self.preprocess_image(roi)
            results = self.reader.readtext(processed)
            if not results:
                return "", 0.0

            texts = []
            confidences = []
            for r in results:
                # r[1] es el texto, r[2] es la confianza
                texts.append(r[1])
                confidences.append(r[2])

            combined_text = " ".join(texts).strip()
            avg_confidence = float(np.mean(confidences)) if confidences else 0.0
            return combined_text, avg_confidence
        except Exception as e:
            logger.error(f"Error al extraer texto con EasyOCR: {e}")
            return "", 0.0


class VisionPipeline:
    """Orquestador principal del hilo de procesamiento de visión computacional.

    Mapea la ingesta de frames, filtrado YOLO / ROI, deduplicación y OCR.
    """

    def __init__(
        self,
        source_type: str,
        target_id: str,
        active_profile: str,
        get_roi_callback: Callable[[str], Optional[Dict[str, float]]],
        on_ocr_update: Callable[[Dict[str, Any]], None]
    ) -> None:
        """Inicializa el pipeline de visión.

        Args:
            source_type: 'monitor' o 'camera'.
            target_id: Identificador físico.
            active_profile: Perfil de juego activo.
            get_roi_callback: Callback para leer de SQLite las coordenadas ROI guardadas.
            on_ocr_update: Callback para despachar eventos de OCR al servidor WS.
        """
        self.ingester = VideoIngester(source_type, target_id)
        self.segmenter = YOLOSegmenter()
        self.ocr_engine = OCREngine()

        self.active_profile = active_profile
        self.get_roi_callback = get_roi_callback
        self.on_ocr_update = on_ocr_update

        self._running = False
        self._task: Optional[asyncio.Task[None]] = None
        self._executor = ThreadPoolExecutor(max_workers=2)

        # Filtro de duplicados por dhash y MSE
        self.last_roi_hash: Optional[Any] = None
        self.last_roi_small: Optional[np.ndarray] = None
        self.last_text: str = ""
        self.last_frame: Optional[np.ndarray] = None
        self._processing_vision: bool = False

    def start(self) -> None:
        """Inicia el pipeline asíncrono en segundo plano."""
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("Pipeline de visión computacional iniciado.")

    async def stop(self) -> None:
        """Detiene el pipeline de visión y limpia recursos."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.ingester.release()
        self._executor.shutdown(wait=False)
        logger.info("Pipeline de visión computacional detenido.")

    def _is_duplicate_roi(self, roi: np.ndarray) -> bool:
        """Determina si la ROI es duplicada usando dHash (ImageHash) y MSE.

        Args:
            roi: Imagen recortada de la zona de diálogo.

        Returns:
            Verdadero si la ROI es idéntica o tiene una variación < 5%.
        """
        try:
            # 1. Hashing Perceptivo (dHash) usando PIL
            pil_img = Image.fromarray(cv2.cvtColor(roi, cv2.COLOR_BGR2RGB))
            curr_hash = imagehash.dhash(pil_img)

            # Comparación dHash
            if self.last_roi_hash is not None:
                hash_diff = curr_hash - self.last_roi_hash
                # dHash 8x8 (64 bits): diff <= 3 (~5% de diferencia)
                if hash_diff <= 3:
                    return True

            # 2. Resguardo por Diferencia Cuadrática Media (MSE)
            resized = cv2.resize(roi, (100, 100))
            if self.last_roi_small is not None:
                mse = np.mean((resized.astype(np.float32) - self.last_roi_small.astype(np.float32)) ** 2)
                # MSE < 150 representa una variación visual menor al 5%
                if mse < 150.0:
                    return True

            self.last_roi_hash = curr_hash
            self.last_roi_small = resized
            return False
        except Exception as e:
            logger.error(f"Error en filtro de duplicación: {e}")
            return False

    async def _process_vision_async(self, frame: np.ndarray) -> None:
        """Procesa YOLO y OCR de forma totalmente asíncrona sin bloquear la captura."""
        if self._processing_vision:
            return
        self._processing_vision = True
        try:
            loop = asyncio.get_running_loop()
            h, w = frame.shape[:2]

            # 1. Verificar si hay ROI guardado para este perfil
            roi_coords = self.get_roi_callback(self.active_profile)
            detections = []
            dialog_box: Optional[Dict[str, Any]] = None
            avatar_detected = False
            avatar_hash = ""
            saved_zone_match = False

            if roi_coords:
                saved_zone_match = True
                dialog_box = {
                    "class": "dialog_box",
                    "bbox": {
                        "x1": roi_coords["x1"],
                        "y1": roi_coords["y1"],
                        "x2": roi_coords["x2"],
                        "y2": roi_coords["y2"]
                    },
                    "confidence": 1.0
                }
            else:
                detections = await loop.run_in_executor(
                    self._executor, self.segmenter.detect, frame
                )
                for det in detections:
                    if det["class"] == "dialog_box":
                        if dialog_box is None or det["confidence"] > dialog_box["confidence"]:
                            dialog_box = det
                    elif det["class"] == "avatar":
                        avatar_detected = True

            # 2. Procesar OCR si hay caja de diálogo
            if dialog_box:
                bbox = dialog_box["bbox"]
                x1_px = int(bbox["x1"] * w)
                y1_px = int(bbox["y1"] * h)
                x2_px = int(bbox["x2"] * w)
                y2_px = int(bbox["y2"] * h)

                if x2_px > x1_px and y2_px > y1_px:
                    roi = frame[y1_px:y2_px, x1_px:x2_px]

                    if avatar_detected:
                        avatar_hash = hashlib.md5(roi.tobytes()).hexdigest()[:10]

                    is_dup = self._is_duplicate_roi(roi)
                    if is_dup and self.last_text:
                        pass
                    else:
                        text, conf = await loop.run_in_executor(
                            self._executor, self.ocr_engine.extract_text, roi
                        )
                        if text:
                            # Saneamiento de texto por regex whitelist
                            import re
                            try:
                                # Whitelist pattern: a-zA-Z, accented letters, digits, spaces, basic punctuation
                                pattern = re.compile(
                                    r'[^a-zA-Z0-9\s\u00e1\u00e9\u00ed\u00f3\u00fa\u00c1\u00c9\u00cd\u00d3\u00da\u00f1\u00d1\u00fc\u00dc\u00bf\u003f\u00a1\u0021\u002e\u002c\u003a\u003b\u002d\u0022\u0027\u0028\u0029]'
                                )
                                text_sanitized = pattern.sub('', text)
                                text_sanitized = re.sub(r'\s+', ' ', text_sanitized).strip()
                                
                                # Validar que tenga al menos 3 caracteres útiles (letras/números)
                                useful_chars = sum(1 for c in text_sanitized if c.isalnum())
                            except Exception as sanitize_err:
                                logger.error(f"Error sanitizando texto: {sanitize_err}")
                                text_sanitized = ""
                                useful_chars = 0

                            if text_sanitized and useful_chars >= 3:
                                self.last_text = text_sanitized
                                payload = {
                                    "text_raw": text_sanitized,
                                    "confidence": conf,
                                    "bbox": bbox,
                                    "avatar_detected": avatar_detected,
                                    "avatar_hash": avatar_hash,
                                    "saved_zone_match": saved_zone_match
                                }
                                self.on_ocr_update(payload)
        except Exception as e:
            logger.error(f"Error procesando visión asíncrona: {e}")
        finally:
            self._processing_vision = False

    async def _loop(self) -> None:
        """Bucle de captura a máxima velocidad (tiempo real)."""
        loop = asyncio.get_running_loop()
        while self._running:
            try:
                frame = await loop.run_in_executor(self._executor, self.ingester.capture_frame)
                if frame is None:
                    await asyncio.sleep(0)
                    continue

                self.last_frame = frame
                # Disparar tarea asíncrona para YOLO/OCR sin bloquear la captura
                asyncio.create_task(self._process_vision_async(frame))

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error en bucle de captura: {e}")

            await asyncio.sleep(0)
