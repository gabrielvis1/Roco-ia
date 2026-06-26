import { useState, useEffect, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface GameProfile {
  profile_id: string;
  game_title: string;
  last_played?: string;
}

interface ApiKey {
  id: number;
  key_value: string;
  active: number;
  failed_attempts: number;
}

export default function App() {
  // Consumir el hook de comunicación con el backend de Python
  const { status, messages, sendMessage, clearMessages } = useWebSocket("ws://localhost:8000/ws");

  // --- Estados de Datos ---
  const [games, setGames] = useState<GameProfile[]>([]);
  const [activeGameId, setActiveGameId] = useState<string>("");
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  // --- Estados de Configuración ---
  const [inputLang, setInputLang] = useState<string>("es");
  const [outputLang, setOutputLang] = useState<string>("es");
  const [volume, setVolume] = useState<number>(80);
  const [isMicActive, setIsMicActive] = useState<boolean>(false);
  const [isHudPassive, setIsHudPassive] = useState<boolean>(false);

  // --- Estados del Formulario / Modal ---
  const [showAddProfileModal, setShowAddProfileModal] = useState<boolean>(false);
  const [newProfileId, setNewProfileId] = useState<string>("");
  const [newProfileTitle, setNewProfileTitle] = useState<string>("");

  const [newApiKey, setNewApiKey] = useState<string>("GEMINI-API-");

  // Notificación Toast
  const [toast, setToast] = useState<string | null>(null);

  // Referencia para la consola de logs (Auto-scroll)
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  /**
   * Muestra un aviso temporal en pantalla.
   */
  const triggerToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  /**
   * Actualiza el submenú de perfiles rápidos nativo del SysTray de Windows.
   * Envía los títulos de los últimos 5 perfiles de juego jugados.
   */
  const syncSysTrayProfiles = (profilesList: GameProfile[]) => {
    try {
      const top5Titles = profilesList.slice(0, 5).map((p) => p.game_title);
      invoke("update_quick_profiles", { profiles: top5Titles }).catch((err) => {
        console.error("Fallo al actualizar perfiles del SysTray:", err);
      });
    } catch (e) {
      console.error(e);
    }
  };

  // --- Efecto: Escucha y enrutamiento de eventos entrantes del WebSocket ---
  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    switch (lastMsg.event) {
      case "SYSTEM_STATUS": {
        const payload = lastMsg.payload;
        if (payload.profiles) {
          setGames(payload.profiles);
          syncSysTrayProfiles(payload.profiles);
        }
        if (payload.api_keys) setApiKeys(payload.api_keys);
        if (payload.settings) {
          setInputLang(payload.settings.input_language || "es");
          setOutputLang(payload.settings.output_language || "es");
          setVolume(Number(payload.settings.volume) || 80);
        }
        triggerToast("Sincronización inicial con SQLite completada.");
        break;
      }

      case "USER_SWITCH_GAME_ACK": {
        const payload = lastMsg.payload;
        if (payload.profiles) {
          setGames(payload.profiles);
          syncSysTrayProfiles(payload.profiles);
        }
        if (payload.active_game_id) {
          setActiveGameId(payload.active_game_id);
          const activeGame = games.find((g) => g.profile_id === payload.active_game_id);
          if (activeGame) {
            triggerToast(`Perfil activo cambiado a: ${activeGame.game_title}`);
          }
        }
        break;
      }

      case "CREATE_GAME_PROFILE_ACK": {
        const payload = lastMsg.payload;
        if (payload.profiles) {
          setGames(payload.profiles);
          syncSysTrayProfiles(payload.profiles);
          triggerToast("Nuevo perfil de juego guardado en SQLite.");
        }
        break;
      }

      case "SAVE_SETTING_ACK": {
        const payload = lastMsg.payload;
        triggerToast(`Configuración '${payload.key}' guardada en SQLite.`);
        break;
      }

      case "SAVE_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        triggerToast("Clave API de Gemini registrada con éxito.");
        break;
      }

      case "DEACTIVATE_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        triggerToast("Clave API desactivada en base de datos.");
        break;
      }

      case "TEST_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        if (payload.status === "success") {
          triggerToast("¡Prueba de Clave API completada con ÉXITO!");
        } else {
          triggerToast("Fallo en la Clave API. Se incrementaron los intentos fallidos.");
        }
        break;
      }

      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // --- Efecto: Auto-scroll en la consola de logs ---
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- Efecto: Registrar Eventos Nativos del SysTray ---
  useEffect(() => {
    let unlistenSwitch: (() => void) | null = null;
    let unlistenMic: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        // Escuchar cambio de juego desde el submenú del SysTray
        unlistenSwitch = await listen<string>("tray_switch_game", (event) => {
          const gameTitle = event.payload;
          const found = games.find((g) => g.game_title === gameTitle);
          if (found) {
            handleSelectGame(found.profile_id, found.game_title);
          }
        });

        // Escuchar activación del micrófono desde el SysTray
        unlistenMic = await listen("tray_toggle_mic", () => {
          setIsMicActive((prev) => {
            const newState = !prev;
            sendMessage("SAVE_SETTING", { key: "microphone_active", value: newState });
            return newState;
          });
        });
      } catch (err) {
        console.error("Fallo al registrar listeners nativos de Tauri:", err);
      }
    };

    if (games.length > 0) {
      setupListeners();
    }

    return () => {
      if (unlistenSwitch) unlistenSwitch();
      if (unlistenMic) unlistenMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games]);

  // --- Handlers de Acciones ---

  const handleSelectGame = (profile_id: string, game_title: string) => {
    setActiveGameId(profile_id);
    sendMessage("USER_SWITCH_GAME", {
      game_id: profile_id,
      name: game_title,
    });
  };

  const handleCreateProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileId.trim() || !newProfileTitle.trim()) return;

    const cleanId = newProfileId.toLowerCase().replace(/\s+/g, "_");
    sendMessage("CREATE_GAME_PROFILE", {
      game_id: cleanId,
      name: newProfileTitle.trim(),
    });

    setNewProfileId("");
    setNewProfileTitle("");
    setShowAddProfileModal(false);
  };

  const handleSaveSetting = (key: string, value: string | number) => {
    sendMessage("SAVE_SETTING", { key, value });
  };

  const handleAddApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKey.trim() || newApiKey === "GEMINI-API-") return;

    sendMessage("SAVE_API_KEY", { key_value: newApiKey.trim() });
    setNewApiKey("GEMINI-API-");
  };

  const handleTestApiKey = (id: number, key_value: string) => {
    sendMessage("TEST_API_KEY", { id, key_value });
  };

  const handleDeactivateApiKey = (id: number) => {
    sendMessage("DEACTIVATE_API_KEY", { id });
  };

  const handleToggleHudMode = async (passive: boolean) => {
    try {
      setIsHudPassive(passive);
      await invoke("set_hud_mode", { passive });
      triggerToast(
        passive
          ? "HUD Pasivo (Click-through) activado. Restablécelo desde el menú de bandeja de Windows."
          : "HUD Interactivo activado."
      );
    } catch (err) {
      console.error("Fallo al cambiar modo de ventana:", err);
      triggerToast("Error: No se pudo configurar el HUD interactivo.");
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 p-6 text-slate-300 font-sans select-none relative overflow-hidden">
      {/* Toast Notification */}
      {toast && (
        <div className="absolute top-6 left-1/2 transform -translate-x-1/2 z-50 bg-emerald-950/90 border border-emerald-400 text-emerald-400 px-4 py-2 rounded-lg shadow-[0_0_20px_rgba(52,211,153,0.3)] flex items-center gap-3 animate-pulse">
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-glow shadow-emerald-400"></div>
          <span className="text-xs font-mono font-semibold uppercase tracking-wider">{toast}</span>
        </div>
      )}

      {/* Header */}
      <header className="flex justify-between items-center border-b border-slate-800 pb-4 mb-5">
        <div className="flex items-center gap-3">
          {/* LED Reactivo */}
          <div
            className={`h-3 w-3 rounded-full shadow-[0_0_10px] transition-all duration-300 ${
              status === "CONNECTED"
                ? "bg-emerald-400 shadow-emerald-400 animate-pulse"
                : status === "CONNECTING"
                ? "bg-amber-400 shadow-amber-400 animate-pulse"
                : "bg-red-500 shadow-red-500"
            }`}
          ></div>
          <h1 className="text-lg font-bold tracking-widest text-slate-100 font-mono uppercase">
            ROCO <span className="text-xs text-emerald-400">IA // PHASE 2</span>
          </h1>
        </div>

        {/* WS Connection Mode Badge */}
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1 rounded">
          <span className="text-[10px] font-mono tracking-widest text-slate-500 uppercase">
            WS_LINK:
          </span>
          <span
            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
              status === "CONNECTED"
                ? "text-emerald-400 bg-emerald-400/10"
                : status === "CONNECTING"
                ? "text-amber-400 bg-amber-400/10"
                : "text-red-500 bg-red-500/10"
            }`}
          >
            {status}
          </span>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-hidden">
        {/* Columna de Configuración (7 Columnas) */}
        <section className="lg:col-span-7 flex flex-col gap-5 overflow-y-auto pr-1">
          {/* Fila 1: Selector de Perfiles y Modo HUD */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Perfil de Juego */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-3">
                  <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                    // PERFIL ACTIVO
                  </h2>
                  <button
                    onClick={() => setShowAddProfileModal(true)}
                    className="text-[10px] font-bold px-2 py-0.5 border border-emerald-400/30 text-emerald-400 bg-emerald-400/5 hover:bg-emerald-400 hover:text-black rounded transition-all cursor-pointer"
                  >
                    + AGREGAR
                  </button>
                </div>
                <div className="relative">
                  <select
                    value={activeGameId}
                    onChange={(e) => {
                      const selected = games.find((g) => g.profile_id === e.target.value);
                      if (selected) handleSelectGame(selected.profile_id, selected.game_title);
                    }}
                    className="w-full bg-slate-950/80 border border-slate-850 p-2.5 rounded text-slate-200 text-xs focus:outline-none focus:border-emerald-400 appearance-none font-mono cursor-pointer"
                  >
                    <option value="" disabled>
                      Selecciona un juego...
                    </option>
                    {games.map((game) => (
                      <option key={game.profile_id} value={game.profile_id}>
                        {game.game_title} ({game.profile_id})
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500">
                    ▼
                  </div>
                </div>
              </div>
              <div className="text-[10px] text-slate-500 font-mono mt-3">
                Los perfiles se aíslan automáticamente en SQLite.
              </div>
            </div>

            {/* Modo HUD / Click-Through */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase mb-3 font-mono">
                  // MODO INTERACTIVO HUD
                </h2>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <button
                    onClick={() => handleToggleHudMode(false)}
                    className={`py-2 px-3 border rounded text-[10px] font-bold uppercase transition-all cursor-pointer ${
                      !isHudPassive
                        ? "border-emerald-400 text-emerald-400 bg-emerald-400/5 shadow-[0_0_10px_rgba(52,211,153,0.1)]"
                        : "border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300"
                    }`}
                  >
                    CONFIG
                  </button>
                  <button
                    onClick={() => handleToggleHudMode(true)}
                    className={`py-2 px-3 border rounded text-[10px] font-bold uppercase transition-all cursor-pointer ${
                      isHudPassive
                        ? "border-amber-400 text-amber-400 bg-amber-400/5 shadow-[0_0_10px_rgba(245,158,11,0.1)]"
                        : "border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300"
                    }`}
                  >
                    HUD PASIVO
                  </button>
                </div>
              </div>
              {isHudPassive ? (
                <div className="text-[9px] text-amber-400/80 mt-2 font-mono leading-relaxed animate-pulse">
                  Click-through activo. Usa el SysTray (Abrir Panel) para volver a interactuar.
                </div>
              ) : (
                <div className="text-[10px] text-slate-500 font-mono mt-3">
                  Permite cambiar a ventana pasiva transparente.
                </div>
              )}
            </div>
          </div>

          {/* Fila 2: Selectores de Idioma y Audio */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4">
            <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase mb-4 font-mono">
              // CONFIGURACIÓN DE IDIOMA Y MICROFONO
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Idioma de entrada */}
              <div>
                <label className="block text-[10px] text-slate-500 font-bold uppercase mb-1 font-mono">
                  OCR / Voz (Entrada)
                </label>
                <select
                  value={inputLang}
                  onChange={(e) => {
                    setInputLang(e.target.value);
                    handleSaveSetting("input_language", e.target.value);
                  }}
                  className="w-full bg-slate-950 border border-slate-850 p-2 rounded text-slate-200 text-xs focus:outline-none focus:border-emerald-400 cursor-pointer"
                >
                  <option value="es">Español (ES)</option>
                  <option value="en">Inglés (EN)</option>
                  <option value="pt">Portugués (PT)</option>
                </select>
              </div>

              {/* Idioma de salida */}
              <div>
                <label className="block text-[10px] text-slate-500 font-bold uppercase mb-1 font-mono">
                  Narrador (Salida)
                </label>
                <select
                  value={outputLang}
                  onChange={(e) => {
                    setOutputLang(e.target.value);
                    handleSaveSetting("output_language", e.target.value);
                  }}
                  className="w-full bg-slate-950 border border-slate-850 p-2 rounded text-slate-200 text-xs focus:outline-none focus:border-emerald-400 cursor-pointer"
                >
                  <option value="es">Español (ES)</option>
                  <option value="en">Inglés (EN)</option>
                  <option value="pt">Portugués (PT)</option>
                </select>
              </div>

              {/* Control de Micrófono */}
              <div className="flex flex-col justify-end">
                <button
                  onClick={() => {
                    const nextState = !isMicActive;
                    setIsMicActive(nextState);
                    handleSaveSetting("microphone_active", nextState ? 1 : 0);
                  }}
                  className={`w-full py-2 border rounded text-xs font-bold transition-all cursor-pointer ${
                    isMicActive
                      ? "border-emerald-400 text-emerald-400 bg-emerald-400/5 shadow-[0_0_8px_rgba(52,211,153,0.1)]"
                      : "border-slate-800 text-slate-500 hover:border-slate-700"
                  }`}
                >
                  {isMicActive ? "🎤 MICRO ACTIVO" : "🔇 MICRO APAGADO"}
                </button>
              </div>
            </div>

            {/* Selector de Volumen */}
            <div className="mt-4 pt-4 border-t border-slate-800">
              <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 mb-1">
                <span>VOLUMEN DEL AUDIO</span>
                <span>{volume}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setVolume(val);
                }}
                onMouseUp={() => handleSaveSetting("volume", volume)}
                className="w-full h-1 bg-slate-850 rounded-lg appearance-none cursor-pointer accent-emerald-400"
              />
            </div>
          </div>

          {/* Fila 3: API Keys de Gemini */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex-1 min-h-[220px] flex flex-col justify-between">
            <div>
              <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase mb-3 font-mono">
                // GEMINI API KEYS (CREDENCIALES DE IA)
              </h2>

              <form onSubmit={handleAddApiKey} className="flex gap-2 mb-4">
                <input
                  type="password"
                  placeholder="Introduce tu Gemini API Key..."
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-850 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-400 font-mono"
                />
                <button
                  type="submit"
                  className="bg-emerald-400 text-black font-bold text-xs px-4 rounded hover:bg-emerald-400/80 transition-colors cursor-pointer font-mono"
                >
                  REGISTRAR
                </button>
              </form>

              {/* Lista de claves */}
              <div className="space-y-2 overflow-y-auto max-h-[160px] pr-1">
                {apiKeys.length === 0 ? (
                  <div className="text-center text-xs text-slate-600 italic py-4">
                    No hay llaves de API Gemini registradas.
                  </div>
                ) : (
                  apiKeys.map((key) => (
                    <div
                      key={key.id}
                      className="bg-slate-950 border border-slate-850 rounded p-2 flex justify-between items-center text-xs"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-slate-300">
                          ID {key.id} //{" "}
                          {key.key_value.substring(0, 14)}...
                        </span>
                        <div className="flex gap-2 text-[10px] font-mono">
                          <span
                            className={key.active ? "text-emerald-400" : "text-red-500 font-bold"}
                          >
                            {key.active ? "ESTADO: ACTIVA" : "ESTADO: DESACTIVADA"}
                          </span>
                          <span className="text-slate-600">
                            FALLAS: {key.failed_attempts}/3
                          </span>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleTestApiKey(key.id, key.key_value)}
                          disabled={!key.active}
                          className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                            key.active
                              ? "bg-slate-800 text-amber-400 hover:bg-amber-400 hover:text-black cursor-pointer"
                              : "bg-slate-900 text-slate-600 cursor-not-allowed"
                          }`}
                        >
                          TEST
                        </button>
                        <button
                          onClick={() => handleDeactivateApiKey(key.id)}
                          disabled={!key.active}
                          className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                            key.active
                              ? "bg-slate-800 text-red-400 hover:bg-red-400 hover:text-white cursor-pointer"
                              : "bg-slate-900 text-slate-600 cursor-not-allowed"
                          }`}
                        >
                          APAGAR
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Columna Derecha: Logs de Comunicación (5 Columnas) */}
        <section className="lg:col-span-5 bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex flex-col overflow-hidden">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
              // CONSOLA LOGS WEBSOCKET
            </h2>
            {messages.length > 0 && (
              <button
                onClick={clearMessages}
                className="text-[9px] font-mono tracking-wider border border-red-500/20 text-red-400/80 hover:text-red-400 hover:bg-red-500/5 px-2 py-0.5 rounded cursor-pointer"
              >
                LIMPIAR
              </button>
            )}
          </div>

          <div className="flex-1 bg-slate-950 border border-slate-900 rounded-lg p-3 font-mono text-[10px] overflow-y-auto space-y-3.5 leading-normal select-text selection:bg-slate-850">
            {messages.length === 0 ? (
              <div className="text-slate-600 italic text-center pt-8">
                Esperando flujo de eventos...
              </div>
            ) : (
              messages.map((msg, i) => {
                const isAck = msg.event.endsWith("_ACK");
                const isError = msg.event === "ERROR";
                return (
                  <div
                    key={i}
                    className={`border-l pl-2 py-0.5 transition-all ${
                      isAck
                        ? "border-emerald-500/40 text-slate-300"
                        : isError
                        ? "border-red-500/40 text-red-400"
                        : "border-amber-500/40 text-slate-300"
                    }`}
                  >
                    <div className="flex justify-between text-[9px] text-slate-600 mb-0.5">
                      <span>
                        [EVENT:{" "}
                        <strong
                          className={
                            isAck
                              ? "text-emerald-400"
                              : isError
                              ? "text-red-400"
                              : "text-amber-400"
                          }
                        >
                          {msg.event}
                        </strong>
                        ]
                      </span>
                      <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <pre className="text-[10px] text-slate-400 whitespace-pre-wrap break-all leading-relaxed font-mono">
                      {JSON.stringify(msg.payload, null, 2)}
                    </pre>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </section>
      </main>

      {/* Modal para Registrar Perfil de Juego en Caliente */}
      {showAddProfileModal && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-sm w-full p-5 shadow-2xl relative">
            <button
              onClick={() => setShowAddProfileModal(false)}
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-300 text-sm font-semibold cursor-pointer"
            >
              ✕
            </button>

            <h3 className="text-xs font-bold tracking-widest text-slate-200 uppercase mb-4 font-mono">
              // REGISTRAR NUEVO JUEGO
            </h3>

            <form onSubmit={handleCreateProfile} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  Identificador del Juego (Ej: zelda_totk)
                </label>
                <input
                  type="text"
                  required
                  placeholder="ej: zelda_totk"
                  value={newProfileId}
                  onChange={(e) => setNewProfileId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-200 focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  Título Público del Juego (Ej: Zelda: TOTK)
                </label>
                <input
                  type="text"
                  required
                  placeholder="ej: Zelda: Tears of the Kingdom"
                  value={newProfileTitle}
                  onChange={(e) => setNewProfileTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-850 rounded p-2 text-slate-200 focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddProfileModal(false)}
                  className="flex-1 py-2 border border-slate-800 hover:border-slate-600 rounded text-slate-500 hover:text-slate-300 cursor-pointer font-bold uppercase"
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-400 text-black font-bold rounded hover:bg-emerald-400/80 cursor-pointer uppercase"
                >
                  REGISTRAR
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
