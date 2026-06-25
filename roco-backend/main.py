"""Script de entrada principal y orquestador asíncrono del servicio Roco.

Carga la configuración global, inicializa el servidor WebSocket
y maneja el ciclo de vida de la ejecución asíncrona.
"""

import asyncio
import sys
from src.config import SystemConfig
from src.server import WebSocketServer
from src.utils import AsyncLogger


async def main(logger: AsyncLogger) -> None:
    """Función principal asíncrona que orquesta el arranque del backend.

    Args:
        logger: Instancia de AsyncLogger para registro de eventos.
    """
    config = SystemConfig()
    server = WebSocketServer(config, logger)

    await server.start()

    try:
        # Mantiene el bucle de eventos corriendo indefinidamente
        await asyncio.Future()
    except asyncio.CancelledError:
        logger.info("El bucle de ejecución principal fue cancelado.")
    finally:
        # Apagado ordenado del servidor y desconexión de clientes
        await server.stop()


if __name__ == "__main__":
    sys_logger = AsyncLogger()
    sys_logger.info("Iniciando entorno Roco v2.0...")
    try:
        asyncio.run(main(sys_logger))
    except KeyboardInterrupt:
        sys_logger.warn("Apagado del sistema solicitado por el usuario (Ctrl+C).")
        sys.exit(0)
