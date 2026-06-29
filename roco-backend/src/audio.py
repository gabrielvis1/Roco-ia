import random
"""Módulo de procesamiento de audio en tiempo real para Roco.

Contiene la máquina de estados de audio (AudioFSM), el detector de Wake Word
local (Rustpotter), el motor de transcripción Faster-Whisper, y el sintetizador
de voz local (Kokoro-ONNX / SAPI5).
"""

import asyncio
import hashlib
import sys
import time
from enum import Enum
from concurrent.futures import ThreadPoolExecutor
from typing import cast, Any, Callable, Dict, List, Optional

import numpy as np
from loguru import logger

# Cargadores dinámicos para evitar fallos de importación previos a instalación
WhisperModel: Optional[Any] = None
try:
    from faster_whisper import WhisperModel as WM
    WhisperModel = WM
except ImportError:
    logger.warning("No se pudo importar faster-whisper. Se usará modo simulado.")

Kokoro: Optional[Any] = None
try:
    from kokoro_onnx import Kokoro as K
    Kokoro = K
except ImportError:
    logger.warning("No se pudo importar kokoro-onnx. Se usará modo simulado.")

import sounddevice as sd


class AudioState(Enum):
    """Estados admitidos por la Máquina de Estados de Audio (FSM)."""
    SLEEPING = "SLEEPING"
    ACTIVE_ONE_SHOT = "ACTIVE_ONE_SHOT"
    CONTINUOUS_CONVERSATION = "CONTINUOUS_CONVERSATION"


class FasterWhisperSTT:
    """Motor local de reconocimiento de habla (STT) utilizando faster-whisper."""

    def __init__(self, model_size: str = "tiny") -> None:
        self.model: Optional[Any] = None
        if WhisperModel is not None:
            try:
                # tiny o base en int8 para CPU de bajo consumo
                self.model = WhisperModel(model_size, device="cpu", compute_type="int8")
                logger.success(f"Modelo faster-whisper '{model_size}' cargado exitosamente en CPU (int8)")
            except Exception as e:
                logger.error(f"Fallo cargando modelo faster-whisper: {e}")

    def transcribe(self, audio_data: np.ndarray) -> str:
        """Transcribe un arreglo de audio float32 a 16000Hz mono.

        Args:
            audio_data: Fragmento de audio crudo.

        Returns:
            Texto transcrito en minúsculas y limpio, o cadena vacía si falla.
        """
        if self.model is None:
            return ""
        try:
            # vad_filter filtra los silencios usando silero-vad internamente
            segments, info = self.model.transcribe(audio_data, beam_size=1, vad_filter=True)
            text = " ".join(seg.text for seg in segments).strip()
            return text
        except Exception as e:
            logger.error(f"Error transcribiendo audio con faster-whisper: {e}")
            return ""


class KokoroTTS:
    """Motor de síntesis de voz (TTS) local mediante Kokoro-ONNX con fallback nativo SAPI5."""

    def __init__(self, model_path: str = "models/kokoro-v0.19.onnx", voices_path: str = "models/voices.json") -> None:
        self.kokoro: Optional[Any] = None
        self.sapi_voice: Optional[Any] = None
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.dispatch: Optional[Callable[[str, Dict[str, Any]], None]] = None

        # 1. Intentar cargar Kokoro-ONNX
        if Kokoro is not None:
            try:
                import os
                if os.path.exists(model_path) and os.path.exists(voices_path):
                    self.kokoro = Kokoro(model_path, voices_path)
                    logger.success(f"Kokoro-ONNX cargado exitosamente con el modelo {model_path}")
                else:
                    logger.warning("Archivos de modelo de Kokoro no encontrados. Se usará SAPI5 de Windows como resguardo.")
            except Exception as e:
                logger.error(f"Error al inicializar Kokoro-ONNX: {e}")

        # 2. Inicializar SAPI5 de Windows como fallback si Kokoro no está disponible
        if self.kokoro is None and sys.platform == "win32":
            try:
                import comtypes.client
                self.sapi_voice = comtypes.client.CreateObject("SAPI.SpVoice")
                logger.success("SAPI5 (Voz nativa de Windows) inicializado como resguardo de TTS.")
            except Exception as e:
                logger.error(f"No se pudo inicializar SAPI5: {e}")

        # Mapeo preestablecido de hashes de avatares a voces de Kokoro
        self.avatar_voice_mapping = {
            "fem_sarah": "af_sarah",
            "masc_adam": "am_adam",
            "default": "af_sarah"
        }

    def speak(self, text: str, voice_name: str = "af_sarah") -> None:
        """Sintetiza y reproduce el texto de forma síncrona con telemetría de volumen en tiempo real."""
        try:
            if self.kokoro is not None:
                samples, sample_rate = self.kokoro.create(text, voice=voice_name, speed=1.0, lang="en-us")
                # Reproducir usando sounddevice de forma no bloqueante inicial
                sd.play(samples, sample_rate)
                
                # Transmitir volumen RMS dinámicamente cada 50ms durante la duración del audio
                total_samples = len(samples)
                chunk_duration = 0.05  # 50ms
                chunk_samples = int(sample_rate * chunk_duration)
                
                start_time = time.time()
                play_duration = total_samples / sample_rate
                
                while time.time() - start_time < play_duration:
                    elapsed = time.time() - start_time
                    current_sample_idx = int(elapsed * sample_rate)
                    chunk = samples[current_sample_idx : current_sample_idx + chunk_samples]
                    if len(chunk) > 0:
                        rms = float(np.sqrt(np.mean(chunk**2)))
                        db = 20 * np.log10(rms + 1e-5)
                        vol_norm = float(max(0.0, min(100.0, (db + 60) * 1.67)))
                        if self.dispatch:
                            self.dispatch("TTS_VOLUME_UPDATE", {"volume": vol_norm})
                    time.sleep(chunk_duration)
                
                # Restablecer volumen a 0
                if self.dispatch:
                    self.dispatch("TTS_VOLUME_UPDATE", {"volume": 0.0})
                sd.wait()
                logger.info(f"TTS Kokoro reproducido: '{text}' usando voz '{voice_name}'")

            elif self.sapi_voice is not None:
                # SVSFlagsAsync = 1
                self.sapi_voice.Speak(text, 1)
                
                # Medir estado de voz y oscilar el vúmetro
                while self.sapi_voice.Status.RunningState == 2:
                    vol_norm = float(random.randint(35, 75))
                    if self.dispatch:
                        self.dispatch("TTS_VOLUME_UPDATE", {"volume": vol_norm})
                    time.sleep(0.05)
                
                # Restablecer volumen a 0
                if self.dispatch:
                    self.dispatch("TTS_VOLUME_UPDATE", {"volume": 0.0})
                logger.info(f"TTS SAPI5 reproducido: '{text}'")
            else:
                logger.warning(f"No hay motor TTS activo para reproducir: '{text}'")
        except Exception as e:
            logger.error(f"Error en la síntesis o reproducción del audio: {e}")

    async def speak_async(self, text: str, voice_name: str = "af_sarah") -> None:
        """Dispara la síntesis de voz en un hilo paralelo no bloqueante."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self.executor, self.speak, text, voice_name)


class RustpotterWakeWordDetector:
    """Motor de detección de Wake Word local para las palabras clave: 'Roco' y 'Oye Roco!'."""

    def __init__(self, stt_engine: FasterWhisperSTT, on_detect: Callable[[], None]) -> None:
        self.stt = stt_engine
        self.on_detect = on_detect
        self.buffer: np.ndarray = np.zeros(32000, dtype=np.float32)  # Buffer de 2 segundos a 16000Hz
        self.cool_down = 0.0
        # Umbral de energía RMS para filtrar silencio y ahorrar CPU (evita inferencia Whisper innecesaria)
        self.energy_threshold = 0.015

    def process_audio(self, chunk: np.ndarray) -> None:
        """Introduce una porción de audio de 16kHz y ejecuta la lógica de detección.

        Args:
            chunk: Muestras de audio mono float32.
        """
        chunk_len = len(chunk)
        if chunk_len >= len(self.buffer):
            self.buffer = chunk[-len(self.buffer):]
        else:
            self.buffer = np.roll(self.buffer, -chunk_len)
            self.buffer[-chunk_len:] = chunk

        if time.time() < self.cool_down:
            return

        # Medir la energía del audio en el buffer
        rms = np.sqrt(np.mean(self.buffer**2))
        if rms > self.energy_threshold:
            # Transcripción rápida de baja latencia sobre el buffer de 2 segundos
            text = self.stt.transcribe(self.buffer).lower()
            if "roco" in text or "roko" in text or "rocco" in text:
                logger.info(f"Wake Word 'Roco' detectado con éxito: '{text}' (RMS: {rms:.4f})")
                self.cool_down = time.time() + 3.0  # Cooldown de 3 segundos para evitar rebotes
                self.on_detect()


class AudioFSM:
    """Máquina de Estados Finita (FSM) de audio de Roco."""

    def __init__(
        self,
        stt_engine: FasterWhisperSTT,
        tts_engine: KokoroTTS,
        websocket_dispatcher: Callable[[str, Dict[str, Any]], None],
        switch_game_callback: Optional[Callable[[str], None]] = None,
        speech_callback: Optional[Callable[[str], None]] = None
    ) -> None:
        self.state = AudioState.SLEEPING
        self.stt = stt_engine
        self.tts = tts_engine
        self.dispatch = websocket_dispatcher
        self.switch_game_callback = switch_game_callback
        self.speech_callback = speech_callback
        # Asignar dispatcher de telemetría de volumen al TTS
        self.tts.dispatch = self.dispatch

        # Wake Word detector
        self.wake_detector = RustpotterWakeWordDetector(
            stt_engine=self.stt,
            on_detect=self.handle_wake_word
        )

        # Buffers y variables de control de VAD
        self.voice_buffer: List[np.ndarray] = []
        self._silence_start: Optional[float] = None
        self._processing_speech = False
        self._executor = ThreadPoolExecutor(max_workers=2)

    def handle_wake_word(self) -> None:
        """Callback ejecutado al oír 'Roco' o 'Oye Roco!'."""
        if self.state == AudioState.SLEEPING:
            self.transition_to(AudioState.ACTIVE_ONE_SHOT)

    def transition_to(self, new_state: AudioState) -> None:
        """Aplica la transición de estado y la notifica al frontend."""
        logger.info(f"FSM de Audio: {self.state.name} -> {new_state.name}")
        self.state = new_state
        self.dispatch("AUDIO_STATE_CHANGED", {"state": new_state.name})

        # Inicializar buffers
        self.voice_buffer = []
        self._silence_start = None

    def feed_audio(self, chunk: np.ndarray) -> None:
        """Inyecta el fragmento de audio proveniente del micrófono.

        Args:
            chunk: Datos de audio capturados a 16kHz float32.
        """
        # En reposo, alimentamos el procesador de Wake Word
        if self.state == AudioState.SLEEPING:
            self.wake_detector.process_audio(chunk)
            return

        # En estados activos, acumulamos el audio y aplicamos VAD para detectar fin de frase
        if self.state in (AudioState.ACTIVE_ONE_SHOT, AudioState.CONTINUOUS_CONVERSATION):
            self.voice_buffer.append(chunk)

            # VAD por RMS (silencio prolongado > 1.2 segundos delimita el fin de la frase)
            rms = np.sqrt(np.mean(chunk**2))
            if rms < 0.008:
                if self._silence_start is None:
                    self._silence_start = time.time()
                elif time.time() - self._silence_start > 1.2:
                    asyncio.create_task(self.process_accumulated_speech())
            else:
                self._silence_start = None

    async def process_accumulated_speech(self) -> None:
        """Concatena el audio acumulado, transcribe con faster-whisper, y evalúa comandos."""
        if not self.voice_buffer or self._processing_speech:
            return

        self._processing_speech = True
        try:
            # Concatenar buffers de audio
            audio_np = np.concatenate(self.voice_buffer)
            self.voice_buffer = []
            self._silence_start = None

            # Transcribir de forma asíncrona
            loop = asyncio.get_running_loop()
            text = await loop.run_in_executor(self._executor, self.stt.transcribe, audio_np)

            if text:
                logger.success(f"Habla de usuario transcribida: '{text}'")

                # Enviar actualización al frontend
                self.dispatch("USER_STT_UPDATE", {
                    "text": text,
                    "state": self.state.name
                })

                text_clean = text.lower().strip().replace(",", "").replace(".", "").replace("!", "")

                # 1. Comprobar comandos de cambio de juego por voz primero
                if "cambia de juego a" in text_clean or "cambia a" in text_clean:
                    parts = text_clean.split("cambia de juego a") if "cambia de juego a" in text_clean else text_clean.split("cambia a")
                    if len(parts) > 1 and self.switch_game_callback:
                        game_name = parts[1].strip()
                        self.switch_game_callback(game_name)
                        if self.state == AudioState.ACTIVE_ONE_SHOT:
                            self.transition_to(AudioState.SLEEPING)
                        return

                # 2. Evaluar cambios de estado y comandos conversacionales
                if self.state == AudioState.ACTIVE_ONE_SHOT:
                    if "hablemos de corrido" in text_clean:
                        self.transition_to(AudioState.CONTINUOUS_CONVERSATION)
                        await self.tts.speak_async("Continuous conversation mode active.")
                    else:
                        # Consulta general a Roco
                        if self.speech_callback:
                            self.speech_callback(text)
                        self.transition_to(AudioState.SLEEPING)
                elif self.state == AudioState.CONTINUOUS_CONVERSATION:
                    if "descansa" in text_clean:
                        self.transition_to(AudioState.SLEEPING)
                        await self.tts.speak_async("Resting now.")
                    else:
                        # Consulta en conversación continua
                        if self.speech_callback:
                            self.speech_callback(text)

        except Exception as e:
            logger.error(f"Fallo procesando flujo de habla: {e}")
        finally:
            self._processing_speech = False
