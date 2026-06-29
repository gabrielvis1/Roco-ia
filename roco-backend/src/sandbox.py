import asyncio
"""Aislamiento de datos y base de datos vectorial (Sandbox) por videojuego.

Gestiona las bases de datos SQLite relacionales (game_state.db), el almacenamiento
vectorial local (ChromaDB) y el directorio de avatares de cada perfil.
"""

import os
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional, cast
from loguru import logger

# Cargador dinámico para ChromaDB
chromadb: Optional[Any] = None
try:
    import chromadb as cdb
    chromadb = cdb
except ImportError:
    logger.warning("No se pudo importar chromadb. Se usará almacenamiento vectorial en memoria.")


def get_hashing_embedding(text: str) -> List[float]:
    """Genera un embedding de 384 dimensiones usando el truco de hash de palabras.

    Es totalmente offline, rápido y no requiere descargar modelos pesados.

    Args:
        text: Texto de entrada.

    Returns:
        Vector de float32 normalizado de 384 dimensiones.
    """
    words = text.lower().split()
    vector = [0.0] * 384
    for word in words:
        h = hash(word) % 384
        vector[h] += 1.0
    norm = sum(x * x for x in vector) ** 0.5
    if norm > 0.0:
        vector = [x / norm for x in vector]
    return vector


class GameSandbox:
    """Clase que encapsula el Sandbox de datos de un videojuego específico."""

    def __init__(self, game_id: str) -> None:
        """Inicializa directorios y conexiones de base de datos para el juego.

        Args:
            game_id: Identificador único del juego (ej. 'elden_ring').
        """
        self.game_id = game_id
        self.profile_path = Path("profiles") / game_id
        self.avatars_path = self.profile_path / "avatars"
        self.db_path = self.profile_path / "game_state.db"
        self.vectors_path = self.profile_path / "lore_vectors.db"

        # Crear directorios si no existen
        self.avatars_path.mkdir(parents=True, exist_ok=True)

        # 1. Inicializar SQLite del juego
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_sqlite_tables()

        # 2. Inicializar base de datos vectorial ChromaDB
        self._executor = ThreadPoolExecutor(max_workers=1)
        self.chroma_client: Optional[Any] = None
        self.collection: Optional[Any] = None
        self._in_memory_vectors: List[Dict[str, Any]] = []  # Fallback si no está chromadb

        if chromadb is not None:
            try:
                # Usar base de datos persistente local
                self.chroma_client = chromadb.PersistentClient(path=str(self.vectors_path))
                self.collection = self.chroma_client.get_or_create_collection(name="lore")
                logger.success(f"ChromaDB local cargado en el sandbox '{game_id}'")
            except Exception as e:
                logger.error(f"Error inicializando ChromaDB. Usando fallback en memoria: {e}")
                self.chroma_client = None

    def _init_sqlite_tables(self) -> None:
        """Crea de forma automática el esquema relacional inicial en SQLite."""
        cursor = self.conn.cursor()
        try:
            # Tabla de Personajes
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS characters (
                    char_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    avatar_path TEXT,
                    voice_profile_id TEXT,
                    biography TEXT,
                    notes TEXT
                );
            """)

            # Tabla de Inventario
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS inventory_items (
                    item_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    location_discovered TEXT,
                    timestamp_found TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # Tabla de Conversación
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversation_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    speaker TEXT NOT NULL,
                    text_content TEXT NOT NULL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            self.conn.commit()
        except Exception as e:
            logger.error(f"Error inicializando tablas relacionales del Sandbox: {e}")

    def close(self) -> None:
        """Cierra de forma limpia todas las conexiones del Sandbox."""
        try:
            self.conn.close()
            logger.info(f"Conexión SQLite cerrada para el sandbox '{self.game_id}'")
        except Exception as e:
            logger.error(f"Error cerrando SQLite del Sandbox: {e}")

        # Limpiar referencias de ChromaDB
        self.chroma_client = None
        self.collection = None
        self._executor.shutdown(wait=False)

    # --- Operaciones Relacionales (SQLite) ---

    def add_conversation(self, speaker: str, text: str) -> None:
        """Guarda un mensaje en el historial de conversación del juego."""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                "INSERT INTO conversation_history (speaker, text_content) VALUES (?, ?)",
                (speaker, text)
            )
            self.conn.commit()
        except Exception as e:
            logger.error(f"Error guardando conversación: {e}")

    def get_conversation_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Devuelve los últimos mensajes del chat."""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                "SELECT speaker, text_content, timestamp FROM conversation_history ORDER BY id DESC LIMIT ?",
                (limit,)
            )
            rows = cursor.fetchall()
            # Invertir para que queden cronológicos
            return [{"speaker": r["speaker"], "text": r["text_content"], "timestamp": r["timestamp"]} for r in reversed(rows)]
        except Exception as e:
            logger.error(f"Error obteniendo historial: {e}")
            return []

    # --- Operaciones Vectoriales (ChromaDB + ThreadPoolExecutor RAG) ---

    def _add_vector_sync(self, doc_id: str, text: str, metadata: Dict[str, Any]) -> None:
        """Operación síncrona interna para agregar datos vectoriales."""
        embedding = get_hashing_embedding(text)
        if self.collection is not None:
            try:
                self.collection.add(
                    documents=[text],
                    embeddings=[embedding],
                    ids=[doc_id],
                    metadatas=[metadata]
                )
            except Exception as e:
                logger.error(f"Error en ChromaDB add: {e}")
        else:
            self._in_memory_vectors.append({
                "id": doc_id,
                "text": text,
                "embedding": embedding,
                "metadata": metadata
            })

    async def add_lore(self, doc_id: str, text: str, metadata: Dict[str, Any]) -> None:
        """Agrega un fragmento de lore de forma asíncrona no bloqueante."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            self._executor,
            self._add_vector_sync,
            doc_id,
            text,
            metadata
        )

    def _query_vector_sync(self, query_text: str, n_results: int = 3) -> List[Dict[str, Any]]:
        """Operación síncrona interna para buscar similitud semántica."""
        query_emb = get_hashing_embedding(query_text)
        if self.collection is not None:
            try:
                results = self.collection.query(
                    query_embeddings=[query_emb],
                    n_results=n_results
                )
                output = []
                documents = results.get("documents", [[]])[0]
                metadatas = results.get("metadatas", [[]])[0]
                ids = results.get("ids", [[]])[0]
                for i in range(len(documents)):
                    output.append({
                        "id": ids[i],
                        "text": documents[i],
                        "metadata": metadatas[i]
                    })
                return output
            except Exception as e:
                logger.error(f"Error en ChromaDB query: {e}")
                return []
        else:
            # Fallback local usando similitud de coseno en memoria
            scored = []
            for item in self._in_memory_vectors:
                emb = item["embedding"]
                # Producto punto de vectores normalizados (similitud de coseno)
                dot = sum(x * y for x, y in zip(query_emb, emb))
                scored.append((dot, item))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [
                {
                    "id": item["id"],
                    "text": item["text"],
                    "metadata": item["metadata"]
                }
                for _, item in scored[:n_results]
            ]

    async def query_lore(self, query_text: str, n_results: int = 3) -> List[Dict[str, Any]]:
        """Busca información de lore semánticamente similar (RAG) en un hilo secundario."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._query_vector_sync,
            query_text,
            n_results
        )
