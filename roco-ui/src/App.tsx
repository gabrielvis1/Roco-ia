import { useWebSocket } from "./hooks/useWebSocket";

export default function App() {
  // Consumir el hook de comunicación WebSocket
  const { status, messages, sendMessage, clearMessages } = useWebSocket("ws://localhost:8765");

  /**
   * Dispara un evento de prueba hacia el servidor de Python.
   */
  const handleTestEvent = () => {
    sendMessage("USER_SWITCH_GAME", {
      game: "Valorant",
      mode: "Competitivo",
      agent: "Jett",
    });
  };

  return (
    <div className="flex flex-col h-screen bg-gamer-dark p-6 text-slate-300">
      {/* Cabecera Gamer de Roco */}
      <header className="flex justify-between items-center border-b border-gamer-border pb-4 mb-6">
        <div className="flex items-center gap-3">
          <div
            className={`h-4 w-4 rounded-full shadow-[0_0_8px] transition-all duration-300 ${
              status === "CONNECTED"
                ? "bg-gamer-neonGreen shadow-gamer-neonGreen"
                : status === "CONNECTING"
                ? "bg-gamer-neonYellow shadow-gamer-neonYellow"
                : "bg-red-500 shadow-red-500"
            }`}
          ></div>
          <h1 className="text-xl font-bold tracking-wider text-slate-100 uppercase">
            ROCO <span className="text-xs text-gamer-neonGreen font-mono">v2.0</span>
          </h1>
        </div>

        {/* Indicador de Estado del WebSocket */}
        <div className="flex items-center gap-2 bg-gamer-panel px-3 py-1.5 rounded border border-gamer-border">
          <span className="text-xs font-mono uppercase tracking-widest text-slate-400">WS Local:</span>
          <span
            className={`text-xs font-bold font-mono px-2 py-0.5 rounded transition-colors duration-300 ${
              status === "CONNECTED"
                ? "text-gamer-neonGreen bg-gamer-neonGreen/10"
                : status === "CONNECTING"
                ? "text-gamer-neonYellow bg-gamer-neonYellow/10"
                : "text-red-500 bg-red-500/10"
            }`}
          >
            {status}
          </span>
        </div>
      </header>

      {/* Contenedor Principal */}
      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 overflow-hidden">
        {/* Panel Izquierdo: Configuración General */}
        <section className="bg-gamer-panel border border-gamer-border rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase mb-4">
              Configuración Inicial
            </h2>
            <p className="text-sm text-slate-400 mb-6">
              El entorno de Tauri v2 y React está listo. El cliente WebSocket se reconecta automáticamente al backend en caso de caída.
            </p>

            <div className="space-y-4">
              <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Acciones de Prueba
              </h3>
              <button
                onClick={handleTestEvent}
                disabled={status !== "CONNECTED"}
                className={`w-full py-2.5 px-4 rounded font-semibold text-xs tracking-wider uppercase border transition-all duration-200 ${
                  status === "CONNECTED"
                    ? "bg-gamer-neonGreen/10 border-gamer-neonGreen text-gamer-neonGreen hover:bg-gamer-neonGreen hover:text-black cursor-pointer shadow-[0_0_12px_rgba(57,255,20,0.15)]"
                    : "bg-slate-800/30 border-slate-700/50 text-slate-600 cursor-not-allowed"
                }`}
              >
                Simular USER_SWITCH_GAME
              </button>
              <p className="text-[11px] text-slate-500 italic">
                {status !== "CONNECTED"
                  ? "Reconecta el backend en Python para habilitar el envío de eventos."
                  : "Presiona el botón para enviar una acción y recibir un acuse de recibo ACK."}
              </p>
            </div>
          </div>

          <div className="text-xs text-slate-500 border-t border-gamer-border pt-4">
            Autor: Elvis Gabriel Briceño Cuba (Copiloto de Desarrollo)
          </div>
        </section>

        {/* Panel Derecho: Consola del Sistema */}
        <section className="bg-gamer-panel border border-gamer-border rounded-lg p-5 flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
              Logs de Comunicación
            </h2>
            {messages.length > 0 && (
              <button
                onClick={clearMessages}
                className="text-[10px] uppercase font-mono tracking-wider text-red-400/80 hover:text-red-400 transition-colors cursor-pointer border border-red-500/20 px-2 py-0.5 rounded hover:bg-red-500/10"
              >
                Limpiar Logs
              </button>
            )}
          </div>

          <div className="flex-1 bg-black/40 rounded border border-gamer-border p-4 font-mono text-xs overflow-y-auto space-y-4">
            {messages.length === 0 ? (
              <div className="text-slate-600 italic text-center pt-8">
                Esperando eventos de comunicación...
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className={`border-l-2 pl-3 py-1 transition-all duration-300 ${
                    msg.event.endsWith("_ACK")
                      ? "border-gamer-neonGreen/50 text-slate-300"
                      : msg.event === "ERROR"
                      ? "border-red-500/50 text-red-300"
                      : "border-gamer-neonYellow/50 text-slate-300"
                  }`}
                >
                  <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                    <span>
                      Evento:{" "}
                      <strong
                        className={
                          msg.event.endsWith("_ACK") ? "text-gamer-neonGreen" : "text-slate-300"
                        }
                      >
                        {msg.event}
                      </strong>
                    </span>
                    <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="text-[11px] text-slate-400 whitespace-pre-wrap break-all font-mono">
                    {JSON.stringify(msg.payload, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
