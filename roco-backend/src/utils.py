"""Módulo de utilidades de registro de eventos (logging) para Roco.

Proporciona un formateador estético y asíncronamente seguro con colores
para la consola del sistema y almacenamiento en archivo utilizando la librería Loguru.
"""

import sys
from loguru import logger

# Configurar Loguru: remover el handler por defecto e inicializar los nuestros
logger.remove()

# Handler para la consola con colores gamer
logger.add(
    sys.stdout,
    format="<light-black>[{time:HH:mm:ss}]</light-black> | <level>{level: <7}</level> | <level>{message}</level>",
    level="INFO",
    colorize=True,
)

# Handler para almacenar los logs en archivo físico
logger.add(
    "roco_backend.log",
    rotation="10 MB",
    retention="1 week",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <7} | {message}",
    level="DEBUG",
    encoding="utf-8",
)


class AsyncLogger:
    """Registrador de logs personalizado.

    Formatea y redirige las llamadas hacia la librería Loguru para
    salida en terminal y persistencia en archivo.
    """

    @classmethod
    def success(cls, message: str) -> None:
        """Registra un mensaje de éxito/handshake exitoso."""
        logger.success(message)

    @classmethod
    def info(cls, message: str) -> None:
        """Registra un mensaje informativo del sistema."""
        logger.info(message)

    @classmethod
    def warn(cls, message: str) -> None:
        """Registra una advertencia/aviso."""
        logger.warning(message)

    @classmethod
    def error(cls, message: str) -> None:
        """Registra un error crítico."""
        logger.error(message)
