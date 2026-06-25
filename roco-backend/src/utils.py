"""Módulo de utilidades de registro de eventos (logging) para Roco.

Proporciona un formateador estético y asíncronamente seguro con colores
para la consola del sistema.
"""

from datetime import datetime
from typing import Final


class AsyncLogger:
    """Registrador de logs personalizado con soporte para códigos de color ANSI.

    Formatea la salida en consola simulando una terminal oscura de estilo gamer.
    """

    # Códigos ANSI para colores en consola
    COLOR_RESET: Final[str] = "\033[0m"
    COLOR_TIME: Final[str] = "\033[90m"      # Gris
    COLOR_SUCCESS: Final[str] = "\033[38;5;82m"  # Verde Neón
    COLOR_INFO: Final[str] = "\033[36m"         # Cian/Azul
    COLOR_WARN: Final[str] = "\033[33m"         # Amarillo
    COLOR_ERROR: Final[str] = "\033[31m"        # Rojo

    @classmethod
    def _get_timestamp(cls) -> str:
        """Obtiene la marca de tiempo actual formateada."""
        now: datetime = datetime.now()
        return f"{cls.COLOR_TIME}[{now.strftime('%H:%M:%S')}]{cls.COLOR_RESET}"

    @classmethod
    def success(cls, message: str) -> None:
        """Registra un mensaje de éxito/handshake en verde neón."""
        print(f"{cls._get_timestamp()} {cls.COLOR_SUCCESS}[ÉXITO] {message}{cls.COLOR_RESET}")

    @classmethod
    def info(cls, message: str) -> None:
        """Registra un mensaje informativo del sistema en cian."""
        print(f"{cls._get_timestamp()} {cls.COLOR_INFO}[INFO] {message}{cls.COLOR_RESET}")

    @classmethod
    def warn(cls, message: str) -> None:
        """Registra una advertencia en amarillo."""
        print(f"{cls._get_timestamp()} {cls.COLOR_WARN}[AVISO] {message}{cls.COLOR_RESET}")

    @classmethod
    def error(cls, message: str) -> None:
        """Registra un error en rojo."""
        print(f"{cls._get_timestamp()} {cls.COLOR_ERROR}[ERROR] {message}{cls.COLOR_RESET}")
