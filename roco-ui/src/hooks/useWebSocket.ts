import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Literal que define los estados permitidos de la conexión WebSocket.
 */
export type WSStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED";

/**
 * Interfaz que define la estructura exacta del protocolo de comunicación de Roco.
 */
export interface WSMessage {
  event: string;
  timestamp: string;
  payload: Record<string, any>;
}

/**
 * Hook personalizado para gestionar la comunicación bidireccional mediante WebSockets.
 * Implementa reconexión inteligente (backoff exponencial) y cola de mensajes fuera de línea.
 *
 * @param url Dirección del servidor WebSocket (por defecto: ws://localhost:8000/ws).
 * @returns API pública inmutable para interactuar con el socket y leer su estado.
 */
export function useWebSocket(url: string = "ws://localhost:8000/ws") {
  const [status, setStatus] = useState<WSStatus>("DISCONNECTED");
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  // Referencias para almacenar instancias y estados mutables sin provocar re-renderizados
  const socketRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<WSMessage[]>([]);
  const reconnectDelayRef = useRef<number>(1000); // 1 segundo inicial
  const reconnectTimerRef = useRef<number | null>(null);

  // Mantener la URL actualizada en una referencia para evitar reconstruir las funciones de callbacks
  const urlRef = useRef<string>(url);
  urlRef.current = url;

  /**
   * Método asíncrono privado para intentar conectarse al servidor WebSocket.
   * Administra la lógica de registro de listeners y reconexiones.
   */
  const connect = useCallback(() => {
    // Si ya estamos conectados o intentando conectar, evitamos duplicar la conexión
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.OPEN ||
        socketRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // Cancelar cualquier temporizador de reconexión pendiente para evitar llamadas cruzadas
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setStatus("CONNECTING");

    try {
      const ws = new WebSocket(urlRef.current);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus("CONNECTED");
        // Conexión exitosa, restablecer el tiempo de reconexión al valor inicial
        reconnectDelayRef.current = 1000;

        // Despachar los mensajes acumulados en la cola de mensajes fuera de línea
        const pendingMessages = queueRef.current;
        if (pendingMessages.length > 0) {
          pendingMessages.forEach((msg) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(msg));
            }
          });
          // Limpiar la cola una vez enviados
          queueRef.current = [];
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const rawData = JSON.parse(event.data);

          // Validar preventivamente que el JSON contenga la estructura requerida por el protocolo
          if (
            typeof rawData === "object" &&
            rawData !== null &&
            "event" in rawData &&
            "payload" in rawData
          ) {
            const wsMessage: WSMessage = {
              event: String(rawData.event),
              timestamp: String(rawData.timestamp || new Date().toISOString()),
              payload: rawData.payload as Record<string, any>,
            };
            setLastMessage(wsMessage);
          }
        } catch (err) {
          console.error("Error al deserializar el mensaje de entrada:", err);
        }
      };

      ws.onclose = () => {
        setStatus("DISCONNECTED");

        // Implementación del Backoff Exponencial
        const currentDelay = reconnectDelayRef.current;
        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, currentDelay);

        // Incrementar el delay en un 50% para el siguiente reintento (Límite máximo de 30 segundos)
        reconnectDelayRef.current = Math.min(currentDelay * 1.5, 30000);
      };

      ws.onerror = (err) => {
        console.error("Error de WebSocket detectado:", err);
        // La llamada a close() es disparada automáticamente por el navegador tras un error
      };
    } catch (error) {
      console.error("Error de inicialización del socket:", error);
      setStatus("DISCONNECTED");
    }
  }, []);

  /**
   * Envía un mensaje estructurado al servidor WebSocket.
   * Si el socket no está listo, almacena el mensaje en la cola fuera de línea para envío diferido.
   */
  const sendMessage = useCallback((event: string, payload: Record<string, any>) => {
    const wsMessage: WSMessage = {
      event,
      timestamp: new Date().toISOString(),
      payload,
    };

    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(wsMessage));
      } catch (err) {
        console.error("Fallo al despachar el mensaje, encolando:", err);
        queueRef.current.push(wsMessage);
      }
    } else {
      // Guardar el mensaje en memoria hasta que la conexión se restablezca
      queueRef.current.push(wsMessage);
    }
  }, []);

  /**
   * Utilidad para vaciar el historial local de logs de la consola en la interfaz.
   */
  const clearMessages = useCallback(() => {
    setLastMessage(null);
  }, []);

  // Efecto que controla el montaje inicial y desmontaje
  useEffect(() => {
    connect();

    return () => {
      // Cancelar temporizador de reconexión si estuviera corriendo
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      const ws = socketRef.current;
      if (ws) {
        // Remover listeners explícitamente para evitar fugas de memoria al desmontar
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        socketRef.current = null;
      }
    };
  }, [connect]);

  // Exponer API pública inmutable
  return {
    status,
    lastMessage,
    sendMessage,
    clearMessages,
  };
}
