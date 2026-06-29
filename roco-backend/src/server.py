"""Módulo del servidor WebSocket para Roco.

Contiene la lógica de comunicación bidireccional asíncrona orientada a objetos
con el panel de control (frontend) de la aplicación, interactuando con la base de datos SQLite
y controlando la captura de periféricos de hardware en tiempo real.
"""

import asyncio
import base64
import json
import sys
from datetime import datetime
from typing import Any, Dict, Optional, Set, cast
import cv2
import mss
import numpy as np
import pygetwindow as gw
import sounddevice as sd
from websockets.asyncio.server import Server, serve, ServerConnection
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from .config import SystemConfig
from .database import DatabaseManager
from .hardware import HardwareScanner
from .utils import AsyncLogger
from .vision import VisionPipeline
from .audio import FasterWhisperSTT, KokoroTTS, AudioFSM, AudioState


class WebSocketServer:
    """Servidor de WebSockets asíncrono para gestionar la interfaz del panel de Roco.

    Encapsula el ciclo de vida, escuchando eventos del cliente, interactuando
    con la base de datos local y transmitiendo capturas de pantalla/video en vivo.
    """

    def __init__(self, config: SystemConfig, logger: AsyncLogger, db: DatabaseManager) -> None:
        """Inicializa el servidor WebSocket con la configuración, logger y DB inyectados.

        Args:
            config: Instancia de SystemConfig con los parámetros de conexión.
            logger: Instancia de AsyncLogger para el registro estético de eventos.
            db: Instancia de DatabaseManager para la gestión de persistencia local.
        """
        self._config: SystemConfig = config
        self._logger: AsyncLogger = logger
        self._db: DatabaseManager = db
        self._server: Optional[Server] = None
        self._connected_clients: Set[ServerConnection] = set()

        # Gestión del bucle de captura de video en vivo
        self._preview_task: Optional[asyncio.Task[None]] = None
        self._preview_active: bool = False

        # Gestión del micrófono en segundo plano
        self._mic_stream: Optional[sd.InputStream] = None

        # Configuración de previsualización en caliente
        preview_width_str = self._db.get_setting("preview_width", "0") or "0"
        if preview_width_str == "480":
            preview_width_str = "0"
            self._db.save_setting("preview_width", "0")
        self._preview_width: int = int(preview_width_str)

        preview_quality_str = self._db.get_setting("preview_jpeg_quality", "100") or "100"
        if preview_quality_str == "50" or preview_quality_str == "95":
            preview_quality_str = "95"
            self._db.save_setting("preview_jpeg_quality", "100")
        self._preview_jpeg_quality: int = int(preview_quality_str)

        # Sincronización de configuraciones al arrancar
        self.active_game_profile: str = self._db.get_setting("active_game_profile", "default") or "default"
        self.output_language: str = self._db.get_setting("output_language", "es") or "es"
        self.active_capture_source: str = self._db.get_setting("active_capture_source", "") or ""
        self.microphone_device_id: str = self._db.get_setting("microphone_device_id", "default") or "default"
        self.microphone_active: bool = (self._db.get_setting("microphone_active", "1") in ("1", "true", "True", True))
        try:
            self.microphone_gain: int = int(self._db.get_setting("microphone_gain", "80") or "80")
        except ValueError:
            self.microphone_gain = 80

        # Pipeline de visión
        self._vision_pipeline: Optional[VisionPipeline] = None

        # Referencia al bucle de ejecución asíncrono
        self.loop: Optional[asyncio.AbstractEventLoop] = None

        # Inicialización de motores de audio de la Fase 4
        self._stt = FasterWhisperSTT(model_size="tiny")
        self._tts = KokoroTTS()
        self._audio_fsm = AudioFSM(
            stt_engine=self._stt,
            tts_engine=self._tts,
            websocket_dispatcher=self.broadcast_audio_event
        )

    def _get_client_address(self, websocket: ServerConnection) -> str:
        """Obtiene la dirección de red formateada del cliente.

        Args:
            websocket: Conexión del cliente.

        Returns:
            Dirección del cliente en formato host:port o 'Desconocido'.
        """
        remote_addr = websocket.remote_address
        return f"{remote_addr[0]}:{remote_addr[1]}" if remote_addr else "Desconocido"

    async def _send_json(self, websocket: ServerConnection, data: Dict[str, Any]) -> None:
        """Envía un mensaje formateado en JSON de manera segura al cliente.

        Maneja preventivamente las posibles desconexiones de red durante la transmisión.

        Args:
            websocket: Conexión activa del cliente.
            data: Diccionario con la estructura de datos a serializar y enviar.
        """
        try:
            message_str = json.dumps(data)
            await websocket.send(message_str)
        except ConnectionClosedOK:
            pass
        except ConnectionClosedError as e:
            self._logger.warn(f"No se pudo enviar JSON. Conexión cerrada inesperadamente: {e}")
        except Exception as e:
            self._logger.error(f"Error inesperado al enviar JSON: {e}")

    def broadcast_audio_event(self, event: str, payload: Dict[str, Any]) -> None:
        """Transmite un evento estructurado de audio a todos los clientes WebSocket."""
        if self.loop is not None:
            for ws in list(self._connected_clients):
                asyncio.run_coroutine_threadsafe(
                    self._send_json(ws, {
                        "event": event,
                        "timestamp": datetime.now().isoformat(),
                        "payload": payload
                    }),
                    self.loop
                )

    async def _send_handshake(self, websocket: ServerConnection) -> None:
        """Despacha el mensaje de bienvenida y estado del sistema (SYSTEM_STATUS) al cliente.

        Envía de forma agregada las configuraciones iniciales, perfiles e API keys.

        Args:
            websocket: Conexión activa del cliente.
        """
        try:
            # Obtener datos guardados de la base de datos
            settings = {
                "active_game_profile": self._db.get_setting("active_game_profile", "default"),
                "output_language": self._db.get_setting("output_language", "es"),
                "active_capture_source": self._db.get_setting("active_capture_source", ""),
                "microphone_device_id": self._db.get_setting("microphone_device_id", "default"),
                "microphone_active": self._db.get_setting("microphone_active", "1"),
                "microphone_gain": self._db.get_setting("microphone_gain", "80"),
                "input_language": self._db.get_setting("input_language", "es"),
                "volume": self._db.get_setting("volume", "80"),
                "active_mic": self._db.get_setting("microphone_device_id", "default"),
                "preview_width": self._db.get_setting("preview_width", "480"),
                "preview_jpeg_quality": self._db.get_setting("preview_jpeg_quality", "50"),
            }
            profiles = self._db.get_game_profiles()
            api_keys = self._db.list_api_keys()
            sources = self._db.get_capture_sources()
            audio_devices = await asyncio.get_running_loop().run_in_executor(None, HardwareScanner.get_audio_devices)

            handshake_payload: Dict[str, Any] = {
                "event": "SYSTEM_STATUS",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "ready",
                    "python_version": sys.version,
                    "infrastructure": {
                        "websockets": True,
                        "asyncio": True,
                        "sqlite": True,
                    },
                    "settings": settings,
                    "profiles": profiles,
                    "api_keys": api_keys,
                    "sources": sources,
                    "audio_devices": audio_devices,
                },
            }
            await self._send_json(websocket, handshake_payload)
        except Exception as e:
            self._logger.error(f"Error al armar o enviar el handshake inicial: {e}")

    async def _stop_preview_task(self) -> None:
        """Detiene de forma segura la tarea en segundo plano de captura de frames."""
        self._preview_active = False
        if self._preview_task is not None:
            self._preview_task.cancel()
            try:
                await self._preview_task
            except asyncio.CancelledError:
                pass
            self._preview_task = None

    def _capture_camera(self, cap: Any) -> Optional[np.ndarray]:
        """Captura un frame de video de la cámara activa.

        Args:
            cap: Objeto de captura de OpenCV.

        Returns:
            Frame de imagen capturado en formato numpy o None.
        """
        if cap:
            ret, raw_frame = cap.read()
            if ret:
                return cast(np.ndarray, raw_frame)
        return None

    def _capture_monitor(self, target_id: str) -> Optional[np.ndarray]:
        """Captura de pantalla del monitor seleccionado por su índice.

        Args:
            target_id: Índice del monitor.

        Returns:
            Frame capturado o None.
        """
        try:
            idx = int(target_id)
            with mss.mss() as sct:
                if idx < len(sct.monitors):
                    mon = sct.monitors[idx]
                    img = sct.grab(mon)
                    raw_frame = np.array(img)
                    return cast(np.ndarray, cv2.cvtColor(raw_frame, cv2.COLOR_BGRA2BGR))
        except Exception as e:
            self._logger.error(f"Error capturando monitor {target_id}: {e}")
        return None

    def _capture_window(self, target_id: str) -> Optional[np.ndarray]:
        """Captura de pantalla de la ventana seleccionada del SO.

        Args:
            target_id: Título o índice de la ventana.

        Returns:
            Frame capturado o None.
        """
        try:
            win = None
            all_wins = gw.getAllWindows()
            try:
                win = all_wins[int(target_id)]
            except ValueError:
                for w in all_wins:
                    if w.title == target_id:
                        win = w
                        break
            if win:
                l, t, w_width, w_height = win.left, win.top, win.width, win.height
                if w_width > 0 and w_height > 0:
                    bbox = {"left": l, "top": t, "width": w_width, "height": w_height}
                    with mss.mss() as sct:
                        img = sct.grab(bbox)
                        raw_frame = np.array(img)
                        return cast(np.ndarray, cv2.cvtColor(raw_frame, cv2.COLOR_BGRA2BGR))
        except Exception as e:
            self._logger.error(f"Error capturando ventana {target_id}: {e}")
        return None

    async def _process_and_send_frame(self, websocket: ServerConnection, frame: np.ndarray) -> None:
        """Optimiza, comprime y transmite un frame individual al cliente de forma asíncrona.

        Args:
            websocket: Conexión de websocket de destino.
            frame: Imagen cruda capturada en formato numpy.
        """
        h, w = frame.shape[:2]
        target_width = getattr(self, "_preview_width", 480)
        jpeg_quality = getattr(self, "_preview_jpeg_quality", 50)

        if target_width > 0 and w > target_width:
            ratio = float(target_width) / w
            frame = cv2.resize(frame, (target_width, int(h * ratio)))

        success, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_quality])
        if success:
            jpg_text = base64.b64encode(buffer).decode("utf-8")
            await self._send_json(websocket, {
                "event": "PREVIEW_FRAME",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "image": f"data:image/jpeg;base64,{jpg_text}"
                }
            })

    def _init_camera(self, target_id: str) -> Optional[cv2.VideoCapture]:
        """Inicializa el objeto de captura de video de OpenCV de manera segura."""
        try:
            backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
            cap = cv2.VideoCapture(int(target_id), backend)
            if cap.isOpened():
                return cap
        except Exception as e:
            self._logger.error(f"Fallo al abrir cámara {target_id}: {e}")
        return None

    def _create_fallback_frame(self, source_type: str, target_id: str, error_msg: str) -> np.ndarray:
        """Genera un frame de fallback estético cuando falla la captura de pantalla o cámara."""
        # Crear una imagen negra de 640x360 (16:9)
        frame: np.ndarray = np.zeros((360, 640, 3), dtype=np.uint8)

        # Dibujar bordes de color neón (verde gamer)
        cv2.rectangle(frame, (10, 10), (630, 350), (20, 255, 57), 2)

        # Añadir líneas cruzadas suaves de fondo (estilo HUD)
        cv2.line(frame, (30, 30), (70, 30), (20, 255, 57), 2)
        cv2.line(frame, (30, 30), (30, 70), (20, 255, 57), 2)
        cv2.line(frame, (610, 30), (570, 30), (20, 255, 57), 2)
        cv2.line(frame, (610, 30), (610, 70), (20, 255, 57), 2)

        # Texto principal
        cv2.putText(frame, "ROCO IA - LIVE FEED FALLBACK", (50, 80),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 255, 57), 2, cv2.LINE_AA)

        cv2.putText(frame, f"Fuente: {source_type.upper()} ({target_id})", (50, 130),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1, cv2.LINE_AA)

        # Mensaje explicativo
        if source_type in ("monitor", "window"):
            cv2.putText(frame, "Nota: Windows ha bloqueado la captura GDI por falta de", (50, 190),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 200, 255), 1, cv2.LINE_AA)
            cv2.putText(frame, "permisos interactivos del proceso de fondo (GDI Access Denied).", (50, 215),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 200, 255), 1, cv2.LINE_AA)
            cv2.putText(frame, "Para capturar la pantalla real, inicie el backend manualmente", (50, 255),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.putText(frame, "en su propia terminal: 'venv\\Scripts\\python main.py'", (50, 280),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        else:
            cv2.putText(frame, "Nota: El dispositivo USB esta ocupado (p. ej., abierto en OBS) o inactivo.", (50, 180),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 200, 255), 1, cv2.LINE_AA)
            cv2.putText(frame, "Soluciones rapidas:", (50, 210),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.putText(frame, "1. En OBS: click derecho en fuente -> Proyector de ventana (fuente),", (50, 235),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (240, 240, 240), 1, cv2.LINE_AA)
            cv2.putText(frame, "   y selecciona esa ventana de proyeccion en Roco (Pestaña Ventanas) [¡Recomendado!].", (50, 255),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (20, 255, 57), 1, cv2.LINE_AA)
            cv2.putText(frame, "2. En OBS: inicia la 'Camara Virtual' y selecciona 'OBS Virtual Camera' aqui.", (50, 280),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (240, 240, 240), 1, cv2.LINE_AA)
            cv2.putText(frame, "3. Cierra OBS o desactiva la camara alli para liberar el puerto USB.", (50, 305),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, (240, 240, 240), 1, cv2.LINE_AA)

        # Marca de tiempo en vivo
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        cv2.putText(frame, f"TIME: {ts}", (50, 330),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (100, 100, 100), 1, cv2.LINE_AA)

        return frame

    def _get_frame(self, source_type: str, target_id: str, cap: Any) -> Optional[np.ndarray]:
        """Obtiene un frame basándose en el tipo de fuente de captura especificado."""
        frame = None
        if source_type == "camera":
            frame = self._capture_camera(cap)
        elif source_type == "monitor":
            frame = self._capture_monitor(target_id)
        elif source_type == "window":
            frame = self._capture_window(target_id)

        if frame is None:
            frame = self._create_fallback_frame(source_type, target_id, "Captura fallida")
        return frame

    async def _run_preview(self, websocket: ServerConnection, source_type: str, target_id: str) -> None:
        """Graba y transmite frames comprimidos del monitor, ventana o cámara seleccionada.

        Args:
            websocket: Conexión de websocket de destino.
            source_type: Tipo de fuente ('monitor', 'window', 'camera').
            target_id: Identificador físico o lógico del objetivo.
        """
        loop = asyncio.get_running_loop()

        # Registrar la fuente activa
        self.active_capture_source = f"{source_type}:{target_id}"
        self._db.save_setting("active_capture_source", self.active_capture_source)

        # Inicializar el pipeline de visión de forma no bloqueante
        def on_ocr_update(ocr_payload: Dict[str, Any]) -> None:
            asyncio.run_coroutine_threadsafe(
                self._send_json(websocket, {
                    "event": "OCR_DETECTION_UPDATE",
                    "timestamp": datetime.now().isoformat(),
                    "payload": ocr_payload
                }),
                loop
            )

            # Generación de voz local con Kokoro-82M (TTS)
            text_to_speak = ocr_payload.get("text_raw")
            if text_to_speak:
                avatar_hash = ocr_payload.get("avatar_hash", "default")
                voice_name = self._tts.avatar_voice_mapping.get(avatar_hash, "af_sarah")
                asyncio.run_coroutine_threadsafe(
                    self._tts.speak_async(text_to_speak, voice_name=voice_name),
                    loop
                )

        self._vision_pipeline = VisionPipeline(
            source_type=source_type,
            target_id=target_id,
            active_profile=self.active_game_profile,
            get_roi_callback=self._db.get_game_zone,
            on_ocr_update=on_ocr_update
        )
        self._vision_pipeline.start()

        try:
            while self._preview_active:
                frame = self._vision_pipeline.last_frame if self._vision_pipeline else None
                if frame is None:
                    # Fallback temporal mientras carga o si falla la captura
                    frame = self._create_fallback_frame(source_type, target_id, "Iniciando captura o sin señal...")
                await self._process_and_send_frame(websocket, frame)
                await asyncio.sleep(0)
        except asyncio.CancelledError:
            pass
        finally:
            if self._vision_pipeline:
                await self._vision_pipeline.stop()
                self._vision_pipeline = None
            self._logger.info("Ciclo de captura de previsualización cerrado limpiamente.")

    # --- Controladores de Eventos ---

    async def _handle_create_profile(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Procesa el evento de registro de un nuevo juego en game_profiles."""
        game_id = payload.get("game_id")
        name = payload.get("name")
        if game_id and name:
            self._db.upsert_game_profile(game_id, name)
            updated_profiles = self._db.get_game_profiles()
            await self._send_json(websocket, {
                "event": "CREATE_GAME_PROFILE_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "profiles": updated_profiles
                }
            })

    async def _handle_switch_game(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Procesa el cambio de juego activo y actualiza la fecha de uso."""
        game_id = payload.get("game_id")
        name = payload.get("name")
        if game_id and name:
            self._db.upsert_game_profile(game_id, name)
            updated_profiles = self._db.get_game_profiles()
            await self._send_json(websocket, {
                "event": "USER_SWITCH_GAME_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "active_game_id": game_id,
                    "profiles": updated_profiles
                }
            })

    def _sync_db_settings(self, key: str, value: Any) -> None:
        """Sincroniza configuraciones cruzadas en la base de datos sqlite."""
        if key == "active_mic":
            self._db.save_setting("microphone_device_id", str(value))
        elif key == "microphone_device_id":
            self._db.save_setting("active_mic", str(value))
        elif key == "volume":
            self._db.save_setting("microphone_gain", str(value))
        elif key == "microphone_gain":
            self._db.save_setting("volume", str(value))

    def _update_preview_and_audio_cache(self, key: str, value: Any) -> None:
        """Actualiza la escucha de audio y la caché de previsualización en caliente."""
        if key == "active_game_profile":
            self.active_game_profile = str(value)
            if self._vision_pipeline:
                self._vision_pipeline.active_profile = str(value)
        elif key == "output_language":
            self.output_language = str(value)
        elif key == "active_capture_source":
            self.active_capture_source = str(value)
        elif key in ("microphone_active", "microphone_device_id", "active_mic"):
            if key == "microphone_active":
                self.microphone_active = (str(value) in ("1", "true", "True", True))
            elif key in ("microphone_device_id", "active_mic"):
                self.microphone_device_id = str(value)
            self._start_mic_listener()
        elif key == "microphone_gain":
            try:
                self.microphone_gain = int(value)
            except ValueError:
                pass
        elif key == "preview_width":
            try:
                self._preview_width = int(value)
            except ValueError:
                pass
        elif key == "preview_jpeg_quality":
            try:
                self._preview_jpeg_quality = int(value)
            except ValueError:
                pass

    async def _handle_save_setting(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Guarda una configuración de la aplicación."""
        key = payload.get("key")
        value = payload.get("value")
        if key and value is not None:
            self._db.save_setting(key, str(value))
            self._sync_db_settings(key, value)
            self._update_preview_and_audio_cache(key, value)

            await self._send_json(websocket, {
                "event": "SAVE_SETTING_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "key": key,
                    "value": value
                }
            })

    async def _handle_save_api_key(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Inserta una nueva clave de API."""
        key_value = payload.get("key_value")
        if key_value:
            self._db.insert_api_key(key_value)
            updated_keys = self._db.list_api_keys()
            await self._send_json(websocket, {
                "event": "SAVE_API_KEY_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "api_keys": updated_keys
                }
            })

    async def _handle_deactivate_api_key(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Desactiva lógicamente una clave de API."""
        key_id = payload.get("id")
        if key_id is not None:
            self._db.deactivate_api_key(int(key_id))
            updated_keys = self._db.list_api_keys()
            await self._send_json(websocket, {
                "event": "DEACTIVATE_API_KEY_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "api_keys": updated_keys
                }
            })

    async def _handle_test_api_key(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Prueba una clave de API y la deactiva si falla recurrentemente."""
        key_id = payload.get("id")
        key_value = payload.get("key_value")
        if key_id is not None and key_value:
            success = "invalid" not in key_value.lower() and len(key_value) > 10
            if not success:
                self._db.increment_failed_attempts(int(key_id))

            updated_keys = self._db.list_api_keys()
            await self._send_json(websocket, {
                "event": "TEST_API_KEY_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success" if success else "failed",
                    "id": key_id,
                    "api_keys": updated_keys
                }
            })

    async def _handle_start_preview(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Inicia el bucle asíncrono de previsualización de video en vivo."""
        source_type = payload.get("type")
        target_id = payload.get("target_id")
        if not source_type or target_id is None:
            return

        await self._stop_preview_task()

        self._preview_active = True
        self._preview_task = asyncio.create_task(
            self._run_preview(websocket, source_type, str(target_id))
        )
        self._logger.info(f"Previsualización de video iniciada para: {source_type} ({target_id})")

        await self._send_json(websocket, {
            "event": "START_PREVIEW_ACK",
            "timestamp": datetime.now().isoformat(),
            "payload": {
                "status": "success"
            }
        })

    async def _handle_stop_preview(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Detiene la tarea en segundo plano de previsualización."""
        await self._stop_preview_task()
        await self._send_json(websocket, {
            "event": "STOP_PREVIEW_ACK",
            "timestamp": datetime.now().isoformat(),
            "payload": {
                "status": "success"
            }
        })

    async def _handle_get_hardware_sources(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Devuelve la lista actual de monitores, cámaras USB y ventanas activas del SO."""
        loop = asyncio.get_running_loop()
        usb_devices = await loop.run_in_executor(None, HardwareScanner.get_usb_cameras)
        monitors = await loop.run_in_executor(None, HardwareScanner.get_monitors)
        windows = await loop.run_in_executor(None, HardwareScanner.get_active_windows)

        await self._send_json(websocket, {
            "event": "GET_HARDWARE_SOURCES_ACK",
            "timestamp": datetime.now().isoformat(),
            "payload": {
                "status": "success",
                "received_payload": {
                    "monitors": monitors,
                    "windows": windows,
                    "usb_devices": usb_devices
                }
            }
        })

    async def _handle_save_game_zone(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Guarda las coordenadas relativas de calibración (ROI) en la base de datos."""
        x1 = payload.get("x1")
        y1 = payload.get("y1")
        x2 = payload.get("x2")
        y2 = payload.get("y2")

        if x1 is not None and y1 is not None and x2 is not None and y2 is not None:
            profile_id = self.active_game_profile
            self._db.save_game_zone(profile_id, float(x1), float(y1), float(x2), float(y2))
            self._logger.success(f"Zona ROI guardada para el perfil '{profile_id}': ({x1}, {y1}) a ({x2}, {y2})")

            await self._send_json(websocket, {
                "event": "SAVE_GAME_ZONE_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "profile_id": profile_id,
                    "zone": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
                }
            })

    async def _handle_save_capture_source(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Guarda una nueva fuente en SQLite y devuelve la lista actualizada."""
        name = payload.get("name")
        source_type = payload.get("type")
        target_id = payload.get("target_id")
        if name and source_type and target_id is not None:
            self._db.save_capture_source(name, source_type, str(target_id))
            sources = self._db.get_capture_sources()
            await self._send_json(websocket, {
                "event": "SAVE_CAPTURE_SOURCE_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "sources": sources
                }
            })

    async def _handle_delete_capture_source(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Elimina una fuente existente y actualiza la lista del cliente."""
        name = payload.get("name")
        if name:
            self._db.delete_capture_source(name)
            sources = self._db.get_capture_sources()
            await self._send_json(websocket, {
                "event": "DELETE_CAPTURE_SOURCE_ACK",
                "timestamp": datetime.now().isoformat(),
                "payload": {
                    "status": "success",
                    "sources": sources
                }
            })

    async def _process_message(self, websocket: ServerConnection, message_str: str) -> None:
        """Deserializa y procesa un mensaje entrante, enrutando el evento al controlador apropiado.

        Args:
            websocket: Conexión activa del cliente.
            message_str: Cadena de texto recibida por el socket.
        """
        client_address: str = self._get_client_address(websocket)
        try:
            data: Any = json.loads(message_str)
            if not isinstance(data, dict):
                raise ValueError("El mensaje de entrada no representa un objeto JSON válido.")

            event: Any = data.get("event")
            payload: Any = data.get("payload")

            if not isinstance(event, str) or payload is None:
                self._logger.warn(f"Mensaje malformado recibido de {client_address}: {message_str}")
                await self._send_json(websocket, {
                    "event": "ERROR",
                    "timestamp": datetime.now().isoformat(),
                    "payload": {"message": "El mensaje debe contener las llaves 'event' y 'payload'."}
                })
                return

            self._logger.info(f"Evento '{event}' recibido de {client_address}")

            # Enrutamiento de eventos mediante mapa de controladores
            handlers = {
                "CREATE_GAME_PROFILE": self._handle_create_profile,
                "USER_SWITCH_GAME": self._handle_switch_game,
                "SAVE_SETTING": self._handle_save_setting,
                "SAVE_API_KEY": self._handle_save_api_key,
                "DEACTIVATE_API_KEY": self._handle_deactivate_api_key,
                "TEST_API_KEY": self._handle_test_api_key,
                "START_PREVIEW": self._handle_start_preview,
                "STOP_PREVIEW": self._handle_stop_preview,
                "GET_HARDWARE_SOURCES": self._handle_get_hardware_sources,
                "SAVE_CAPTURE_SOURCE": self._handle_save_capture_source,
                "DELETE_CAPTURE_SOURCE": self._handle_delete_capture_source,
                "SAVE_GAME_ZONE": self._handle_save_game_zone,
            }

            if event in handlers:
                await handlers[event](websocket, payload)
            else:
                # Si no coincide con ninguna acción específica, enviar acuse genérico
                ack_event: str = f"{event}_ACK"
                ack_payload: Dict[str, Any] = {
                    "status": "success",
                    "received_payload": payload
                }
                await self._send_json(websocket, {
                    "event": ack_event,
                    "timestamp": datetime.now().isoformat(),
                    "payload": ack_payload
                })

        except json.JSONDecodeError as e:
            self._logger.error(f"Error de deserialización JSON de {client_address}: {e}")
            await self._send_json(websocket, {
                "event": "ERROR",
                "timestamp": datetime.now().isoformat(),
                "payload": {"message": f"Formato JSON inválido: {str(e)}"}
            })
        except Exception as e:
            self._logger.error(f"Error inesperado procesando mensaje de {client_address}: {e}")

    async def _handler(self, websocket: ServerConnection) -> None:
        """Maneja el ciclo de vida de una conexión individual de cliente.

        Registra el cliente, realiza el handshake inicial y procesa mensajes entrantes.

        Args:
            websocket: Protocolo de conexión de cliente activo.
        """
        client_address: str = self._get_client_address(websocket)
        self._connected_clients.add(websocket)
        self._logger.success(f"Cliente conectado: {client_address}")

        try:
            # Enviar el handshake de bienvenida inicial (sincroniza DB)
            await self._send_handshake(websocket)

            # Bucle asíncrono de lectura de mensajes no bloqueante
            async for message in websocket:
                if isinstance(message, str):
                    await self._process_message(websocket, message)
        except ConnectionClosedOK:
            self._logger.info(f"Conexión cerrada limpiamente por el cliente: {client_address}")
        except ConnectionClosedError as e:
            self._logger.warn(f"Conexión cerrada inesperadamente por el cliente: {client_address}. Detalle: {e}")
        except Exception as e:
            self._logger.error(f"Error en comunicación con {client_address}: {e}")
        finally:
            await self._stop_preview_task()
            self._connected_clients.remove(websocket)
            self._logger.info(f"Cliente desconectado: {client_address}")

    def _resolve_mic_device(self, device_id: str) -> Optional[int]:
        """Resuelve el ID de dispositivo de micrófono en un índice válido para sounddevice."""
        if not device_id or device_id == "default":
            try:
                default_dev = sd.default.device[0]
                return int(default_dev) if default_dev >= 0 else None
            except Exception:
                return None
        try:
            return int(device_id)
        except ValueError:
            return self._find_mic_by_name(device_id)

    def _find_mic_by_name(self, name: str) -> Optional[int]:
        """Busca un micrófono por nombre y devuelve su índice."""
        try:
            devices = sd.query_devices()
            for idx, dev in enumerate(devices):
                if isinstance(dev, dict) and dev.get("max_input_channels", 0) > 0:
                    dev_name = dev.get("name", "")
                    if name.lower() in dev_name.lower():
                        return idx
        except Exception:
            pass
        return None

    def _start_mic_listener(self) -> None:
        """Inicia la escucha del micrófono usando sounddevice de forma asíncrona si está activo."""
        try:
            self._stop_mic_listener()

            mic_active = self._db.get_setting("microphone_active", "1")
            if mic_active not in ("1", "true", "True", True):
                self._logger.info("El micrófono está guardado como inactivo (silenciado) en SQLite.")
                return

            device_id_str = str(self._db.get_setting("microphone_device_id", "default") or "default")
            device_idx = self._resolve_mic_device(device_id_str)

            self._logger.info(
                f"Iniciando flujo de escucha de audio "
                f"(ID guardado: '{device_id_str}', índice: {device_idx})..."
            )

            def callback(indata: Any, frames: Any, time: Any, status: Any) -> None:
                if indata is not None:
                    # Copiar canal mono float32 para inyectar en la FSM
                    audio_chunk = indata[:, 0].copy()
                    self._audio_fsm.feed_audio(audio_chunk)

            self._mic_stream = sd.InputStream(
                device=device_idx,
                channels=1,
                dtype="float32",
                callback=callback,
                samplerate=16000
            )
            self._mic_stream.start()
            self._logger.success("Flujo de entrada de audio (micrófono) activo en segundo plano.")
        except Exception as e:
            self._logger.error(f"Error al iniciar flujo de audio en backend: {e}")
            self._mic_stream = None

    def _stop_mic_listener(self) -> None:
        """Detiene la captura de audio en segundo plano si está activa."""
        if hasattr(self, "_mic_stream") and self._mic_stream is not None:
            try:
                self._mic_stream.stop()
                self._mic_stream.close()
                self._logger.info("Flujo de entrada de audio (micrófono) liberado.")
            except Exception as e:
                self._logger.error(f"Error liberando flujo de audio: {e}")
            finally:
                self._mic_stream = None

    async def start(self) -> None:
        """Arranca el servidor de WebSockets de forma asíncrona."""
        if self._server is not None:
            self._logger.warn("El servidor WebSocket ya se encuentra en ejecución.")
            return

        self.loop = asyncio.get_running_loop()
        self._logger.info(f"Iniciando servidor WebSocket en ws://{self._config.host}:{self._config.port}...")
        try:
            # Inicializar estado de hardware (micrófono) en caliente desde SQLite
            self._start_mic_listener()

            self._server = await serve(
                self._handler,
                self._config.host,
                self._config.port
            )
            self._logger.success("Servidor WebSocket listo y escuchando conexiones.")
        except Exception as e:
            self._logger.error(f"Error al arrancar el servidor en ws://{self._config.host}:{self._config.port}: {e}")
            raise

    async def stop(self) -> None:
        """Detiene el servidor WebSocket y limpia las conexiones abiertas de manera limpia."""
        if self._server is None:
            self._logger.warn("El servidor WebSocket no está iniciado.")
            return

        self._logger.info("Deteniendo servidor WebSocket...")
        await self._stop_preview_task()
        self._stop_mic_listener()

        # Clonamos la lista de clientes para iterar de manera segura
        clients_to_close = list(self._connected_clients)
        for client in clients_to_close:
            try:
                await client.close()
            except Exception as e:
                self._logger.error(f"Error al cerrar la conexión de cliente: {e}")

        try:
            self._server.close()
            await self._server.wait_closed()
        except Exception as e:
            self._logger.error(f"Error al apagar el servidor WebSocket: {e}")
        finally:
            self._server = None
            self._logger.success("Servidor WebSocket apagado correctamente.")
