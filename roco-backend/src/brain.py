"""Capa de Inteligencia Híbrida para Roco.

Contiene el cliente asíncrono GeminiClient para interactuar directamente con la
API de Google AI Studio mediante aiohttp, con rotación en caliente de claves,
deactivación persistente en SQLite y reintentos exponenciales.
"""

import asyncio
from typing import Any, Dict, List
import aiohttp
from loguru import logger


class GeminiClient:
    """Cliente de comunicación asíncrono con la API de Gemini."""

    def __init__(self, api_keys_data: List[Dict[str, Any]], db_manager: Any) -> None:
        """Inicializa el cliente de Gemini con un pool de claves y gestor de DB.

        Args:
            api_keys_data: Lista de diccionarios con 'id', 'key_value', 'active' de SQLite.
            db_manager: Instancia de DatabaseManager de Roco.
        """
        self.api_keys_data = api_keys_data
        self.db = db_manager
        self.current_index = 0
        self.model = "gemini-2.5-flash-preview-09-2025"

    def _get_active_key_data(self) -> Dict[str, Any]:
        """Filtra y obtiene los datos de la clave activa actual."""
        active = [k for k in self.api_keys_data if k.get("active", 1)]
        if not active:
            raise ValueError("No se encontraron claves de API de Gemini activas en el pool.")
        if self.current_index >= len(active):
            self.current_index = 0
        return active[self.current_index]

    def _rotate_and_disable_current(self) -> None:
        """Marca la clave activa actual como inactiva en SQLite y rota el índice."""
        try:
            active_key_data = self._get_active_key_data()
            key_id = active_key_data["id"]
            logger.error(f"Fallo crítico o cuota excedida para clave API ID: {key_id}. Marcándola inactiva.")
            # Marcar inactiva en SQLite
            self.db.deactivate_api_key(key_id)
            # Marcar inactiva en memoria
            active_key_data["active"] = 0
        except Exception as e:
            logger.error(f"Error desactivando clave de API: {e}")
        self.current_index = 0  # Reajustar para apuntar a la siguiente clave activa

    async def generate_content(self, system_prompt: str, user_query: str) -> str:
        """Genera contenido textual a partir de un prompt del sistema y una consulta.

        Args:
            system_prompt: Instrucción de comportamiento del sistema.
            user_query: Consulta enviada por el usuario.

        Returns:
            Texto de respuesta del modelo Gemini.
        """
        payload: Dict[str, Any] = {
            "contents": [{"parts": [{"text": user_query}]}],
            "systemInstruction": {"parts": [{"text": system_prompt}]}
        }
        max_retries = 5
        base_delay = 1.0
        for attempt in range(max_retries):
            try:
                active_data = self._get_active_key_data()
                api_key = active_data["key_value"]
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={api_key}"
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as response:
                        if response.status == 200:
                            result = await response.json()
                            candidates = result.get("candidates", [{}])
                            if candidates:
                                text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                                return str(text)
                        elif response.status == 429:
                            logger.error(f"Fallo 429 en la clave activa. Rotando...")
                            self._rotate_and_disable_current()
                        else:
                            resp_text = await response.text()
                            logger.warning(f"Error {response.status} de Gemini API: {resp_text}")
            except Exception as e:
                logger.error(f"Excepción al invocar Gemini API (intento {attempt+1}): {e}")

            await asyncio.sleep(base_delay * (2 ** attempt))

        raise RuntimeError("La solicitud a Gemini falló tras agotar todos los reintentos y claves.")

    async def generate_multimodal(self, base64_image_data: str) -> str:
        """Analiza una escena visualizada en pantalla mediante la API multimodal de Gemini.

        Args:
            base64_image_data: Cadena Base64 segura que contiene el PNG capturado.

        Returns:
            Texto explicativo con la solución del acertijo en pantalla.
        """
        payload: Dict[str, Any] = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": "Analiza visualmente la escena, los mapas de juego o los textos de la mision mostrados en la pantalla y narra la solucion paso a paso de forma dinamica y concisa para el jugador."},
                    {"inlineData": {"mimeType": "image/png", "data": base64_image_data}}
                ]
            }]
        }
        max_retries = 5
        base_delay = 1.0
        for attempt in range(max_retries):
            try:
                active_data = self._get_active_key_data()
                api_key = active_data["key_value"]
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={api_key}"
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as response:
                        if response.status == 200:
                            result = await response.json()
                            candidates = result.get("candidates", [{}])
                            if candidates:
                                text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                                return str(text)
                        elif response.status == 429:
                            logger.error(f"Fallo 429 en análisis multimodal. Rotando clave...")
                            self._rotate_and_disable_current()
                        else:
                            resp_text = await response.text()
                            logger.warning(f"Error {response.status} multimodal: {resp_text}")
            except Exception as e:
                logger.error(f"Excepción en análisis multimodal (intento {attempt+1}): {e}")

            await asyncio.sleep(base_delay * (2 ** attempt))

        raise RuntimeError("La solicitud multimodal a Gemini falló tras agotar todos los reintentos y claves.")


def cast(type_class: Any, obj: Any) -> Any:
    """Helper simple para tipado estricto."""
    return obj
