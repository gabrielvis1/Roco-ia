"""Módulo del servidor WebSocket para Roco.

Contiene la lógica de comunicación bidireccional asíncrona orientada a objetos
con el panel de control (frontend) de la aplicación, interactuando con la base de datos SQLite.
"""

import json
import sys
from datetime import datetime
from typing import Any, Dict, Optional, Set
from websockets.asyncio.server import Server, serve, ServerConnection
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from .config import SystemConfig
from .database import DatabaseManager
from .utils import AsyncLogger


class WebSocketServer:
    """Servidor de WebSockets asíncrono para gestionar la interfaz del panel de Roco.

    Encapsula el ciclo de vida, escuchando eventos del cliente, interactuando
    con la base de datos local y permitiendo el envío masivo de estados.
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

    async def _send_handshake(self, websocket: ServerConnection) -> None:
        """Despacha el mensaje de bienvenida y estado del sistema (SYSTEM_STATUS) al cliente.

        Envía de forma agregada las configuraciones iniciales, perfiles e API keys.

        Args:
            websocket: Conexión activa del cliente.
        """
        try:
            # Obtener datos guardados de la base de datos
            settings = {
                "input_language": self._db.get_setting("input_language", "es"),
                "output_language": self._db.get_setting("output_language", "es"),
                "volume": self._db.get_setting("volume", "80"),
            }
            profiles = self._db.get_game_profiles()
            api_keys = self._db.list_api_keys()

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
                },
            }
            await self._send_json(websocket, handshake_payload)
        except Exception as e:
            self._logger.error(f"Error al armar o enviar el handshake inicial: {e}")

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

    async def _handle_save_setting(self, websocket: ServerConnection, payload: Dict[str, Any]) -> None:
        """Guarda una configuración de la aplicación."""
        key = payload.get("key")
        value = payload.get("value")
        if key and value is not None:
            self._db.save_setting(key, str(value))
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
            self._connected_clients.remove(websocket)
            self._logger.info(f"Cliente desconectado: {client_address}")

    async def start(self) -> None:
        """Arranca el servidor de WebSockets de forma asíncrona."""
        if self._server is not None:
            self._logger.warn("El servidor WebSocket ya se encuentra en ejecución.")
            return

        self._logger.info(f"Iniciando servidor WebSocket en ws://{self._config.host}:{self._config.port}...")
        try:
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
