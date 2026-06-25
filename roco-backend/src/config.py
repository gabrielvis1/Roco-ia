"""Módulo de configuración global del sistema Roco.

Proporciona las clases y estructuras inmutables para gestionar
los parámetros clave del entorno de ejecución.
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SystemConfig:
    """Clase inmutable que almacena la configuración global del sistema.

    Define las constantes de red por defecto y rutas de acceso a archivos.
    """

    host: str = "localhost"
    port: int = 8765
    base_dir: Path = Path(__file__).resolve().parent.parent
