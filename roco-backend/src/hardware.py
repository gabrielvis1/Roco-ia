"""Módulo de exploración y control de hardware de Roco.

Contiene clases utilitarias para escanear de forma asíncrona y estructurar
los dispositivos de entrada de audio, cámaras de video USB y pantallas/ventanas
activas en el sistema operativo.
"""

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional
import cv2
import mss
import pygetwindow as gw
import sounddevice as sd

from .utils import AsyncLogger


def _check_camera(idx: int) -> Optional[int]:
    """Intenta abrir un índice de cámara en un hilo separado para verificar si está activo."""
    try:
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(idx, backend)
        if cap.isOpened():
            # Intentar configurar propiedades bajas para respuesta rápida
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 240)
            cap.release()
            return idx
    except Exception:
        pass
    return None


def _query_friendly_camera_names() -> List[str]:
    """Consulta la lista de nombres amigables de cámaras en Windows usando PowerShell."""
    friendly_names = []
    try:
        cmd = [
            "powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_PnPEntity | "
            "Where-Object { $_.Service -eq 'usbvideo' } | "
            "Select-Object -ExpandProperty Name"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=3)
        for line in res.stdout.splitlines():
            val = line.strip()
            if val:
                friendly_names.append(val)
    except Exception:
        pass
    return friendly_names


def _map_devices(results: List[Optional[int]], friendly_names: List[str]) -> List[Dict[str, Any]]:
    """Mapea los índices exitosos de cámaras a sus nombres amigables de forma segura."""
    devices = []
    found_idx = 0
    for res in results:
        if res is not None:
            name = f"Cámara USB {res}"
            if found_idx < len(friendly_names):
                name = friendly_names[found_idx]
            elif len(friendly_names) == 1 and res == 2:
                name = friendly_names[0]
            elif friendly_names:
                name = friendly_names[found_idx % len(friendly_names)]

            devices.append({
                "id": str(res),
                "name": f"{name} (Puerto {res})"
            })
            found_idx += 1
    return devices


class HardwareScanner:
    """Escáner de periféricos e interfaces del sistema operativo.

    Proporciona métodos estáticos para auditar cámaras USB, monitores,
    ventanas abiertas del SO y micrófonos conectados.
    """

    @staticmethod
    def get_audio_devices() -> List[Dict[str, Any]]:
        """Obtiene la lista de micrófonos (dispositivos de entrada de audio) conectados.

        Returns:
            Lista de diccionarios representando los dispositivos de audio.
        """
        microphones: List[Dict[str, Any]] = []
        try:
            device_list = sd.query_devices()
            default_input_idx = sd.default.device[0]

            for idx, dev in enumerate(device_list):
                # Filtrar solo dispositivos que soportan canales de entrada (micrófonos)
                if isinstance(dev, dict) and dev.get("max_input_channels", 0) > 0:
                    name_str = dev.get("name", f"Micrófono {idx}")
                    name_clean = name_str.encode("utf-8", errors="ignore").decode("utf-8")
                    microphones.append({
                        "id": str(idx),
                        "name": name_clean,
                        "default": idx == default_input_idx,
                    })
        except Exception as e:
            AsyncLogger.error(f"Fallo al escanear dispositivos de audio: {e}")

        # Fallback si está vacío
        if not microphones:
            microphones = [
                {"id": "default", "name": "Micrófono del Sistema (Mock)", "default": True}
            ]
        return microphones

    @staticmethod
    def get_usb_cameras() -> List[Dict[str, Any]]:
        """Obtiene la lista de cámaras o capturadoras USB usando pygrabber en Windows o fallback."""
        usb_devices: List[Dict[str, Any]] = []

        # Intentar usar pygrabber en Windows
        if sys.platform == "win32":
            try:
                from pygrabber.dshow_graph import FilterGraph
                devices = FilterGraph().get_input_devices()  # type: ignore
                for idx, name in enumerate(devices):
                    name_clean = name.encode("utf-8", errors="ignore").decode("utf-8")
                    usb_devices.append({
                        "id": str(idx),
                        "name": f"{name_clean} (Puerto {idx})"
                    })
            except Exception as e:
                AsyncLogger.warn(f"Fallo al escanear cámaras con pygrabber: {e}")

        # Si no es Windows o pygrabber falló/no retornó dispositivos, usar el método secundario de ThreadPoolExecutor
        if not usb_devices:
            friendly_names = _query_friendly_camera_names()
            try:
                with ThreadPoolExecutor(max_workers=5) as executor:
                    results = list(executor.map(_check_camera, range(5)))
                    usb_devices = _map_devices(results, friendly_names)
            except Exception as e:
                AsyncLogger.error(f"Fallo en escaneo secundario de cámaras USB: {e}")

        # Fallback de último recurso
        if not usb_devices:
            usb_devices = [
                {"id": "0", "name": "Dispositivo de Video USB (Puerto 0) (Mock)"},
                {"id": "1", "name": "Dispositivo de Video USB (Puerto 1) (Mock)"}
            ]
        return usb_devices

    @staticmethod
    def get_active_windows() -> List[Dict[str, Any]]:
        """Escanea todas las ventanas abiertas en el entorno gráfico con título válido.

        Returns:
            Lista de diccionarios conteniendo ID y título de las ventanas activas.
        """
        windows: List[Dict[str, Any]] = []
        try:
            all_windows = gw.getAllWindows()
            seen = set()
            for win in all_windows:
                if win.title:
                    title_clean = win.title.encode("utf-8", errors="ignore").decode("utf-8").strip()
                    if not title_clean:
                        continue
                    if title_clean in ("Program Manager", "Default IME", "MSCTFIME UI"):
                        continue
                    if title_clean in seen:
                        continue
                    seen.add(title_clean)
                    windows.append({
                        "id": title_clean,
                        "name": title_clean,
                        "title": title_clean
                    })
        except Exception as e:
            AsyncLogger.error(f"Fallo al obtener ventanas activas del SO: {e}")

        # Fallback robusto para no retornar lista vacía
        if not windows:
            windows = [
                {"id": "Elden Ring", "name": "Elden Ring (Mock)", "title": "Elden Ring (Mock)"},
                {"id": "Discord", "name": "Discord (Mock)", "title": "Discord (Mock)"},
                {"id": "OBS Studio", "name": "OBS Studio (Mock)", "title": "OBS Studio (Mock)"}
            ]
        return windows

    @staticmethod
    def get_monitors() -> List[Dict[str, Any]]:
        """Consulta los monitores conectados al sistema operativo.

        Returns:
            Lista de diccionarios describiendo cada monitor detectado.
        """
        monitors: List[Dict[str, Any]] = []
        try:
            with mss.mss() as sct:
                for idx, mon in enumerate(sct.monitors):
                    w = mon.get("width", 1920)
                    h = mon.get("height", 1080)
                    if idx == 0:
                        name = f"Escritorio Virtual Completo - {w}x{h}"
                    else:
                        name = f"Monitor {idx} - {w}x{h}"
                    monitors.append({
                        "id": str(idx),
                        "name": name
                    })
        except Exception as e:
            AsyncLogger.error(f"Fallo al obtener monitores del sistema: {e}")

        # Fallback robusto para no retornar lista vacía
        if not monitors:
            monitors = [
                {"id": "1", "name": "Monitor 1 - 1920x1080 (Mock)"},
                {"id": "2", "name": "Monitor 2 - 2560x1440 (Mock)"}
            ]
        return monitors
