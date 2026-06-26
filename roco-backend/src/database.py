"""Módulo de persistencia local en base de datos SQLite para Roco.

Crea automáticamente la base de datos 'config_general.db' si no existe y provee
las tablas para configuración general, claves de API y perfiles de juego.
"""

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


class DatabaseManager:
    """Administrador de la base de datos SQLite para Roco.

    Encapsula todas las consultas e inserciones de forma segura
    con manejo de transacciones y cierres de conexión.
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        """Inicializa el DatabaseManager.

        Args:
            db_path: Ruta al archivo SQLite. Si es None, se autocalcula en el directorio raíz.
        """
        if db_path is None:
            # Colocar la base de datos en el directorio raíz del backend
            self._db_path = Path(__file__).resolve().parent.parent / "config_general.db"
        else:
            self._db_path = db_path

        self._initialize_database()

    def _get_connection(self) -> sqlite3.Connection:
        """Establece y retorna una conexión de base de datos activa.

        Returns:
            Instancia de sqlite3.Connection.
        """
        conn = sqlite3.connect(str(self._db_path))
        # Habilitar el retorno de resultados como diccionarios
        conn.row_factory = sqlite3.Row
        return conn

    def _initialize_database(self) -> None:
        """Crea las tablas requeridas por Roco si no existen en config_general.db."""
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            # Tabla 1: general_settings
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS general_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )

            # Tabla 2: api_keys
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key_value TEXT NOT NULL,
                    active INT DEFAULT 1,
                    failed_attempts INT DEFAULT 0
                )
                """
            )

            # Tabla 3: game_profiles
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS game_profiles (
                    profile_id TEXT PRIMARY KEY,
                    game_title TEXT NOT NULL,
                    last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            # Tabla 4: capture_sources
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS capture_sources (
                    name TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    target_id TEXT NOT NULL
                )
                """
            )

            # Insertar perfiles por defecto si la tabla está vacía
            cursor.execute("SELECT COUNT(*) FROM game_profiles")
            if cursor.fetchone()[0] == 0:
                default_profiles = [
                    ("default", "Default Profile"),
                    ("zelda_totk", "Zelda: Tears of the Kingdom"),
                    ("elden_ring", "Elden Ring"),
                    ("valorant", "Valorant"),
                ]
                cursor.executemany(
                    "INSERT INTO game_profiles (profile_id, game_title) VALUES (?, ?)",
                    default_profiles,
                )

            # Insertar configuraciones globales por defecto si no existen
            default_settings = [
                ("active_game_profile", "default"),
                ("output_language", "es"),
                ("active_capture_source", ""),
                ("microphone_device_id", "default"),
                ("microphone_active", "1"),
                ("microphone_gain", "80"),
                ("input_language", "es"),
                ("volume", "80"),
                ("preview_width", "480"),
                ("preview_jpeg_quality", "50"),
            ]
            cursor.executemany(
                "INSERT OR IGNORE INTO general_settings (key, value) VALUES (?, ?)",
                default_settings,
            )

            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al inicializar la base de datos: {e}")
        finally:
            conn.close()

    # --- Helpers para la tabla general_settings ---

    def save_setting(self, key: str, value: str) -> None:
        """Guarda o actualiza una configuración en general_settings.

        Args:
            key: Identificador de la configuración.
            value: Valor asociado a guardar.
        """
        conn = self._get_connection()
        try:
            conn.execute(
                """
                INSERT INTO general_settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (key, value),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al guardar configuración '{key}': {e}")
        finally:
            conn.close()

    def get_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Obtiene el valor de una configuración por su identificador.

        Args:
            key: Identificador de la configuración.
            default: Valor a retornar si la clave no existe.

        Returns:
            El valor guardado o el valor por defecto.
        """
        conn = self._get_connection()
        try:
            cursor = conn.execute("SELECT value FROM general_settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            if row:
                return str(row["value"])
            return default
        except sqlite3.Error as e:
            raise RuntimeError(f"Error al leer configuración '{key}': {e}")
        finally:
            conn.close()

    # --- Helpers para la tabla api_keys ---

    def insert_api_key(self, key_value: str) -> None:
        """Inserta una nueva clave de API para Gemini.

        Args:
            key_value: La clave de la API enmascarada/provista.
        """
        conn = self._get_connection()
        try:
            conn.execute(
                "INSERT INTO api_keys (key_value) VALUES (?)",
                (key_value,),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al guardar la clave API: {e}")
        finally:
            conn.close()

    def list_api_keys(self) -> List[Dict[str, Any]]:
        """Lista todas las claves API registradas en la base de datos.

        Returns:
            Lista de diccionarios que representan las claves de API.
        """
        conn = self._get_connection()
        try:
            cursor = conn.execute("SELECT id, key_value, active, failed_attempts FROM api_keys")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            raise RuntimeError(f"Error al listar claves API: {e}")
        finally:
            conn.close()

    def deactivate_api_key(self, api_key_id: int) -> None:
        """Desactiva de forma lógica una clave API.

        Args:
            api_key_id: ID autoincremental de la clave.
        """
        conn = self._get_connection()
        try:
            conn.execute(
                "UPDATE api_keys SET active = 0 WHERE id = ?",
                (api_key_id,),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al desactivar clave API: {e}")
        finally:
            conn.close()

    def increment_failed_attempts(self, api_key_id: int) -> None:
        """Incrementa los intentos fallidos y desactiva si supera el límite de 3.

        Args:
            api_key_id: ID autoincremental de la clave.
        """
        conn = self._get_connection()
        try:
            cursor = conn.execute(
                "SELECT failed_attempts FROM api_keys WHERE id = ?",
                (api_key_id,),
            )
            row = cursor.fetchone()
            if row:
                attempts = row["failed_attempts"] + 1
                if attempts >= 3:
                    conn.execute(
                        "UPDATE api_keys SET failed_attempts = ?, active = 0 WHERE id = ?",
                        (attempts, api_key_id),
                    )
                else:
                    conn.execute(
                        "UPDATE api_keys SET failed_attempts = ? WHERE id = ?",
                        (attempts, api_key_id),
                    )
                conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al registrar intento fallido en API Key: {e}")
        finally:
            conn.close()

    # --- Helpers para la tabla game_profiles ---

    def get_game_profiles(self) -> List[Dict[str, Any]]:
        """Lista de perfiles de juegos ordenada por fecha de última sesión de juego.

        Returns:
            Lista de diccionarios ordenados por last_played DESC.
        """
        conn = self._get_connection()
        try:
            cursor = conn.execute(
                "SELECT profile_id, game_title, last_played FROM game_profiles ORDER BY last_played DESC"
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            raise RuntimeError(f"Error al consultar perfiles de juego: {e}")
        finally:
            conn.close()

    def upsert_game_profile(self, profile_id: str, game_title: str) -> None:
        """Inserta o actualiza el perfil del juego y refresca la marca de tiempo de sesión.

        Args:
            profile_id: ID abreviado del perfil (clave primaria).
            game_title: Título descriptivo del juego.
        """
        conn = self._get_connection()
        try:
            conn.execute(
                """
                INSERT INTO game_profiles (profile_id, game_title, last_played)
                VALUES (?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                    game_title = excluded.game_title,
                    last_played = excluded.last_played
                """,
                (profile_id, game_title, datetime.now().isoformat()),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al registrar/actualizar perfil '{profile_id}': {e}")
        finally:
            conn.close()

    # --- Helpers para la tabla capture_sources ---

    def save_capture_source(self, name: str, type_str: str, target_id: str) -> None:
        """Guarda o actualiza una fuente de captura en la base de datos.

        Args:
            name: Nombre personalizado de la fuente.
            type_str: Tipo de fuente ('monitor', 'window', 'camera').
            target_id: Identificador físico/lógico del objetivo.
        """
        conn = self._get_connection()
        try:
            conn.execute(
                """
                INSERT INTO capture_sources (name, type, target_id)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET type=excluded.type, target_id=excluded.target_id
                """,
                (name, type_str, target_id),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al guardar fuente de captura '{name}': {e}")
        finally:
            conn.close()

    def get_capture_sources(self) -> List[Dict[str, Any]]:
        """Obtiene todas las fuentes de captura configuradas en SQLite.

        Returns:
            Lista de diccionarios representando las fuentes.
        """
        conn = self._get_connection()
        try:
            cursor = conn.execute("SELECT name, type, target_id FROM capture_sources")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            raise RuntimeError(f"Error al obtener fuentes de captura: {e}")
        finally:
            conn.close()

    def delete_capture_source(self, name: str) -> None:
        """Elimina una fuente de captura de la base de datos.

        Args:
            name: Nombre de la fuente a eliminar.
        """
        conn = self._get_connection()
        try:
            conn.execute("DELETE FROM capture_sources WHERE name = ?", (name,))
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            raise RuntimeError(f"Error al eliminar fuente de captura '{name}': {e}")
        finally:
            conn.close()
