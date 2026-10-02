"""Public Python SDK. Importing it starts no services and reads no private data."""

from .client import Client, ClientError

__version__ = "4.3.0"
__all__ = ["Client", "ClientError"]
