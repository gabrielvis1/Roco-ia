import { useState, useEffect, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

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

interface CaptureSource {
  name: string;
  type: string;
  target_id: string;
}

interface HardwareSources {
  cameras: { id: string; name: string }[];
  usb_devices: { id: string; name: string }[];
  monitors: { id: string; name: string }[];
  windows: { id: string; title: string; name: string }[];
}

interface ChatMessage {
  id: string;
  sender: "system" | "user" | "roco";
  text: string;
  timestamp: string;
  type?: "success" | "info" | "error";
  payload?: any;
}

export default function App() {
  // Consumir el hook de comunicación con el backend de Python
  const { status, messages, sendMessage, clearMessages } = useWebSocket("ws://localhost:8000/ws");

  // --- Estados de Datos ---
  const [games, setGames] = useState<GameProfile[]>([]);
  const [activeGameId, setActiveGameId] = useState<string>("");
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [sources, setSources] = useState<CaptureSource[]>([]);

  // --- Estados de Configuración ---
  const [outputLang, setOutputLang] = useState<string>("es");
  const [volume, setVolume] = useState<number>(80);
  const [isMicActive, setIsMicActive] = useState<boolean>(false);
  const [isHudPassive, setIsHudPassive] = useState<boolean>(false);
  const [activeMic, setActiveMic] = useState<string>(""); // Perfil de micro en base de datos
  const [windowLabel, setWindowLabel] = useState<string>("main");
  const [ocrData, setOcrData] = useState<any>(null);

  // Estados del lienzo de calibración ROI
  const [isCalibrating, setIsCalibrating] = useState<boolean>(false);
  const [roiBox, setRoiBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // --- Estados de Modales ---
  const [showAddProfileModal, setShowAddProfileModal] = useState<boolean>(false);
  const [newProfileId, setNewProfileId] = useState<string>("");
  const [newProfileTitle, setNewProfileTitle] = useState<string>("");

  const [showApiModal, setShowApiModal] = useState<boolean>(false);
  const [newApiKey, setNewApiKey] = useState<string>("GEMINI-API-");

  const [showMicModal, setShowMicModal] = useState<boolean>(false);

  // Modales secuenciales para OBS Source Manager
  const [showAddSourceModal1, setShowAddSourceModal1] = useState<boolean>(false);
  const [showAddSourceModal2, setShowAddSourceModal2] = useState<boolean>(false);
  const [newSourceName, setNewSourceName] = useState<string>("");
  const [newSourceType, setNewSourceType] = useState<"monitor" | "window" | "camera">("monitor");
  const [newSourceTargetId, setNewSourceTargetId] = useState<string>("");

  // Hardware scanner list
  const [hardwareSources, setHardwareSources] = useState<HardwareSources>({
    cameras: [],
    usb_devices: [],
    monitors: [],
    windows: [],
  });
  const [isLoadingHardware, setIsLoadingHardware] = useState<boolean>(false);

  // Active Preview Source (transmisión por websockets)
  const [activePreviewSource, setActivePreviewSource] = useState<CaptureSource | null>(null);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number>(0);
  const [previewJpegQuality, setPreviewJpegQuality] = useState<number>(95);

  // Lista de Chat y Logs Integrada
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInputText, setChatInputText] = useState<string>("");
  const [expandedLogIds, setExpandedLogIds] = useState<Record<string, boolean>>({});

  // Floating PIP Player Modals
  const [showFloatingPip, setShowFloatingPip] = useState<boolean>(false);

  // Dispositivos de audio en el navegador para el Vúmetro local
  const [browserAudioDevices, setBrowserAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedBrowserDeviceId, setSelectedBrowserDeviceId] = useState<string>("");

  // Notificación Toast
  const [toast, setToast] = useState<string | null>(null);

  // Referencias para el Vúmetro
  const vuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipVuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Referencias de Scroll y estados compartidos para evitar cierres obsoletos
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const lastProcessedMsgRef = useRef<string>("");

  // Referencias para arrastrar el Modal PIP
  const pipContainerRef = useRef<HTMLDivElement | null>(null);
  const [pipPosition, setPipPosition] = useState({ x: 100, y: 100 });
  const [isDraggingPip, setIsDraggingPip] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Muestra una alerta flotante
  const triggerToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const toggleLogExpand = (id: string) => {
    setExpandedLogIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Agrega un mensaje del sistema al chat
  const addSystemChat = (text: string, type: "success" | "info" | "error" = "info", payload?: any) => {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}-${Math.random()}`,
        sender: "system",
        text,
        timestamp: new Date().toISOString(),
        type,
        payload,
      },
    ]);
  };

  // Sincroniza la bandeja del sistema nativa con Tauri
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

  // Inicializar Chat HUD con flujo histórico de ejemplo
  useEffect(() => {
    setChatMessages([
      {
        id: "sys-init",
        sender: "system",
        text: "INICIALIZANDO ROCO v2.0 COGNITION ENGINE...",
        timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        type: "info",
      },
      {
        id: "sys-tauri",
        sender: "system",
        text: "VÍNCULO CON TAURI ESTABLECIDO (HUD ACTIVO)",
        timestamp: new Date(Date.now() - 1000 * 60 * 4.8).toISOString(),
        type: "info",
      },
      {
        id: "msg-user-1",
        sender: "user",
        text: "Roco, detecta el mapa en pantalla y lee los subtítulos de la cinemática.",
        timestamp: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
      },
      {
        id: "msg-roco-1",
        sender: "roco",
        text: "Comprendido. Iniciando OCR local y captura de cuadro de diálogo... Subtítulo detectado: 'Héroe, tu destino aguarda'. Guardando en la memoria del juego (elden_ring).",
        timestamp: new Date(Date.now() - 1000 * 60 * 3.8).toISOString(),
      },
    ]);
  }, []);

  // Enumerar dispositivos de audio en el navegador
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) => {
        const inputs = devices.filter((d) => d.kind === "audioinput");
        setBrowserAudioDevices(inputs);
      })
      .catch((err) => {
        console.error("Error al acceder a los dispositivos de audio locales:", err);
      });
  }, []);

  // Relacionar el micrófono configurado por el backend con el ID del navegador
  useEffect(() => {
    if (activeMic && browserAudioDevices.length > 0) {
      const match = browserAudioDevices.find(
        (d) =>
          d.label.toLowerCase().includes(activeMic.toLowerCase()) ||
          activeMic.toLowerCase().includes(d.label.toLowerCase())
      );
      if (match) {
        setSelectedBrowserDeviceId(match.deviceId);
      }
    }
  }, [activeMic, browserAudioDevices]);

  // Sincronizar automáticamente el ID de la fuente a capturar al cambiar tipo de OBS Source
  useEffect(() => {
    if (newSourceType === "camera") {
      const devs = hardwareSources.usb_devices.length > 0 ? hardwareSources.usb_devices : hardwareSources.cameras;
      if (devs.length > 0) {
        setNewSourceTargetId(devs[0].id);
      } else {
        setNewSourceTargetId("");
      }
    } else if (newSourceType === "monitor" && hardwareSources.monitors.length > 0) {
      setNewSourceTargetId(hardwareSources.monitors[0].id);
    } else if (newSourceType === "window" && hardwareSources.windows.length > 0) {
      setNewSourceTargetId(hardwareSources.windows[0].id);
    } else {
      setNewSourceTargetId("");
    }
  }, [newSourceType, hardwareSources]);

  // Dibujar y animar el Vúmetro local (vertical de OBS)
  const drawVuMeterOnCanvas = (canvas: HTMLCanvasElement, smoothedLevel: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Fondo oscuro
    ctx.fillStyle = "#0c0d0e";
    ctx.fillRect(0, 0, w, h);

    // Relleno de color según nivel (verde, amarillo, rojo) vertical
    const barHeight = h * smoothedLevel;
    const grad = ctx.createLinearGradient(0, h, 0, 0); // Degradado vertical de abajo hacia arriba
    grad.addColorStop(0, "#10b981"); // Verde (-60 a -20 dB)
    grad.addColorStop(0.65, "#f59e0b"); // Amarillo (-20 a -9 dB)
    grad.addColorStop(0.9, "#ef4444"); // Rojo (-9 a 0 dB)

    ctx.fillStyle = grad;
    ctx.fillRect(0, h - barHeight, w, barHeight);

    // Divisiones de decibelios
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    const divisions = [0.2, 0.4, 0.6, 0.8, 0.95];
    divisions.forEach((pct) => {
      ctx.fillRect(0, h * pct, w, 1);
    });
  };

  const startVuMeter = (deviceId: string) => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (!isMicActive) return;

    const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        micStreamRef.current = stream;

        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const audioContext = new AudioContextClass();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        analyserRef.current = analyser;

        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let smoothedLevel = 0;

        const draw = () => {
          if (!analyserRef.current) return;
          animationFrameIdRef.current = requestAnimationFrame(draw);

          analyser.getByteFrequencyData(dataArray);

          let maxVal = 0;
          for (let i = 0; i < bufferLength; i++) {
            if (dataArray[i] > maxVal) {
              maxVal = dataArray[i];
            }
          }

          const currentLevel = maxVal / 255;
          // Caída progresiva (OBS Decay)
          if (currentLevel > smoothedLevel) {
            smoothedLevel = currentLevel;
          } else {
            smoothedLevel = smoothedLevel * 0.92 + currentLevel * 0.08;
          }

          // Dibujar en el canvas principal
          if (vuCanvasRef.current) {
            drawVuMeterOnCanvas(vuCanvasRef.current, smoothedLevel);
          }
          // Dibujar en el canvas flotante PIP
          if (pipVuCanvasRef.current) {
            drawVuMeterOnCanvas(pipVuCanvasRef.current, smoothedLevel);
          }
        };

        draw();
      })
      .catch((err) => {
        console.error("Fallo al iniciar el vúmetro del micrófono:", err);
      });
  };

  // Re-iniciar vúmetro ante cambios de estado
  useEffect(() => {
    if (isMicActive && selectedBrowserDeviceId) {
      startVuMeter(selectedBrowserDeviceId);
    } else {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      // Limpiar vúmetro a fondo gris
      const cleanCanvas = (canvas: HTMLCanvasElement | null) => {
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#0c0d0e";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
        }
      };
      cleanCanvas(vuCanvasRef.current);
      cleanCanvas(pipVuCanvasRef.current);
    }

    return () => {
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [isMicActive, selectedBrowserDeviceId]);

  useEffect(() => {
    try {
      const win = getCurrentWindow();
      setWindowLabel(win.label);
      
      if (win.label === "overlay") {
        invoke("set_hud_click_through", { ignore: true }).catch(console.error);
      }
    } catch (e) {
      console.error("Failed to get current window label:", e);
    }
  }, []);

  useEffect(() => {
    if (windowLabel !== "overlay") return;

    const unlisten = listen<any>("ocr-update", (event) => {
      setOcrData(event.payload);
      
      // Limpiar ocr después de 5 segundos de inactividad
      const timer = setTimeout(() => {
        setOcrData(null);
      }, 5000);
      return () => clearTimeout(timer);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [windowLabel]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setDragStart({ x, y });
    setDragEnd({ x, y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStart || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setDragEnd({ x, y });
  };

  const handleMouseUp = () => {
    if (!dragStart || !dragEnd) return;
    const x1 = Math.min(dragStart.x, dragEnd.x);
    const y1 = Math.min(dragStart.y, dragEnd.y);
    const x2 = Math.max(dragStart.x, dragEnd.x);
    const y2 = Math.max(dragStart.y, dragEnd.y);
    
    if (x2 - x1 > 0.01 && y2 - y1 > 0.01) {
      setRoiBox({ x1, y1, x2, y2 });
    }
    setDragStart(null);
    setDragEnd(null);
  };

  const getDragBoxStyle = () => {
    if (!dragStart || !dragEnd) return {};
    const x1 = Math.min(dragStart.x, dragEnd.x);
    const y1 = Math.min(dragStart.y, dragEnd.y);
    const x2 = Math.max(dragStart.x, dragEnd.x);
    const y2 = Math.max(dragStart.y, dragEnd.y);
    return {
      left: `${x1 * 100}%`,
      top: `${y1 * 100}%`,
      width: `${(x2 - x1) * 100}%`,
      height: `${(y2 - y1) * 100}%`,
    };
  };

  const getRoiBoxStyle = () => {
    if (!roiBox) return {};
    return {
      left: `${roiBox.x1 * 100}%`,
      top: `${roiBox.y1 * 100}%`,
      width: `${(roiBox.x2 - roiBox.x1) * 100}%`,
      height: `${(roiBox.y2 - roiBox.y1) * 100}%`,
    };
  };

  // --- Procesamiento de Eventos WebSocket robusto ante cierres obsoletos ---
  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];

    // Evitar procesamiento duplicado del mismo mensaje
    const msgKey = lastMsg.timestamp + lastMsg.event;
    if (lastProcessedMsgRef.current === msgKey) return;
    lastProcessedMsgRef.current = msgKey;

    switch (lastMsg.event) {
      case "SYSTEM_STATUS": {
        const payload = lastMsg.payload;
        if (payload.profiles) {
          setGames(payload.profiles);
          syncSysTrayProfiles(payload.profiles);
        }
        if (payload.api_keys) setApiKeys(payload.api_keys);
        if (payload.sources) setSources(payload.sources);
        if (payload.settings) {
          const settings = payload.settings;
          setOutputLang(settings.output_language || "es");
          setVolume(Number(settings.volume) || Number(settings.microphone_gain) || 80);
          
          const micActive =
            settings.microphone_active === "1" ||
            settings.microphone_active === "true" ||
            settings.microphone_active === true;
          setIsMicActive(micActive);
          
          const micId = settings.microphone_device_id || settings.active_mic || "default";
          setActiveMic(micId);

          if (settings.active_game_profile) {
            setActiveGameId(settings.active_game_profile);
          }

          if (settings.preview_width) {
            setPreviewWidth(Number(settings.preview_width));
          }
          if (settings.preview_jpeg_quality) {
            setPreviewJpegQuality(Number(settings.preview_jpeg_quality));
          }

          // Restaurar hud_passive
          const hudPassive =
            settings.hud_passive === "1" ||
            settings.hud_passive === "true" ||
            settings.hud_passive === true;
          setIsHudPassive(hudPassive);
          if (hudPassive) {
            WebviewWindow.getByLabel("overlay").then((win) => {
              if (win) win.show().catch(console.error);
            }).catch(console.error);
            invoke("set_hud_click_through", { ignore: true }).catch(console.error);
          }

          // Restaurar active_capture_source y previsualización
          const activeSrcName = settings.active_capture_source;
          if (activeSrcName && payload.sources) {
            const foundSrc = payload.sources.find((s: any) => s.name === activeSrcName);
            if (foundSrc) {
              setActivePreviewSource(foundSrc);
              setPreviewImageSrc(null);
              sendMessage("START_PREVIEW", {
                type: foundSrc.type,
                target_id: foundSrc.target_id,
              });
            }
          }
        }
        triggerToast("Sincronización inicial con SQLite completada.");
        addSystemChat("Conexión del sistema establecida y sincronizada con SQLite.", "info", payload);
        break;
      }

      case "OCR_DETECTION_UPDATE": {
        const payload = lastMsg.payload;
        if (payload) {
          const ocrMsg: ChatMessage = {
            id: `ocr_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            sender: "roco",
            text: payload.text_raw,
            timestamp: new Date().toLocaleTimeString(),
            type: "info"
          };
          setChatMessages((prev) => [...prev, ocrMsg]);
          emit("ocr-update", payload).catch(console.error);
        }
        break;
      }

      case "SAVE_GAME_ZONE_ACK": {
        triggerToast("Límites de calibración (ROI) guardados con éxito.");
        addSystemChat("Zonas de juego de SQLite sincronizadas con éxito.", "success", lastMsg.payload);
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
            addSystemChat(`Perfil de juego cambiado a: ${activeGame.game_title}`, "info", payload);
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
          addSystemChat("Nuevo perfil de juego registrado en SQLite.", "success", payload);
        }
        break;
      }

      case "SAVE_SETTING_ACK": {
        const payload = lastMsg.payload;
        triggerToast(`Configuración '${payload.key}' guardada en SQLite.`);
        if (payload.key === "active_mic") {
          setActiveMic(String(payload.value));
        } else if (payload.key === "microphone_active") {
          setIsMicActive(
            payload.value === 1 ||
              payload.value === "1" ||
              payload.value === true ||
              payload.value === "true"
          );
        } else if (payload.key === "preview_width") {
          setPreviewWidth(Number(payload.value));
        } else if (payload.key === "preview_jpeg_quality") {
          setPreviewJpegQuality(Number(payload.value));
        }
        addSystemChat(`Configuración guardada en base de datos: [${payload.key} = ${payload.value}]`, "success", payload);
        break;
      }

      case "SAVE_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        triggerToast("Clave API de Gemini registrada con éxito.");
        addSystemChat("Nueva clave Gemini API registrada en base de datos.", "success", payload);
        break;
      }

      case "DEACTIVATE_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        triggerToast("Clave API desactivada en base de datos.");
        addSystemChat("Clave Gemini API desactivada correctamente.", "success", payload);
        break;
      }

      case "TEST_API_KEY_ACK": {
        const payload = lastMsg.payload;
        if (payload.api_keys) setApiKeys(payload.api_keys);
        if (payload.status === "success") {
          triggerToast("¡Prueba de Clave API completada con ÉXITO!");
          addSystemChat(`Clave API ID: ${payload.id} verificada con éxito.`, "success", payload);
        } else {
          triggerToast("Fallo en la Clave API. Se incrementaron los intentos fallidos.");
          addSystemChat(`Clave API ID: ${payload.id} falló validación de test.`, "error", payload);
        }
        break;
      }

      case "GET_HARDWARE_SOURCES_ACK": {
        const payload = lastMsg.payload;
        const data = payload.received_payload || payload;
        setHardwareSources({
          cameras: data.usb_devices || data.cameras || [],
          usb_devices: data.usb_devices || data.cameras || [],
          monitors: data.monitors || [],
          windows: (data.windows || []).map((w: any) => ({
            id: String(w.id),
            title: w.title || w.name || "",
            name: w.name || w.title || ""
          })),
        });
        setIsLoadingHardware(false);
        addSystemChat("Fuentes de hardware del sistema analizadas por el backend.", "info", payload);
        break;
      }

      case "SAVE_CAPTURE_SOURCE_ACK": {
        const payload = lastMsg.payload;
        if (payload.sources) setSources(payload.sources);
        triggerToast("Fuente de captura guardada.");
        addSystemChat(`Nueva fuente de captura registrada en SQLite: "${newSourceName}"`, "success", payload);
        setShowAddSourceModal2(false);
        setNewSourceName("");
        break;
      }

      case "DELETE_CAPTURE_SOURCE_ACK": {
        const payload = lastMsg.payload;
        if (payload.sources) setSources(payload.sources);
        triggerToast("Fuente de captura eliminada.");
        addSystemChat("Fuente de captura eliminada de la base de datos.", "success", payload);
        break;
      }

      case "START_PREVIEW_ACK": {
        addSystemChat(`Previsualización en tiempo real iniciada para: "${activePreviewSource?.name}"`, "info", lastMsg.payload);
        break;
      }

      case "STOP_PREVIEW_ACK": {
        addSystemChat("Previsualización de vídeo detenida.", "info", lastMsg.payload);
        break;
      }

      case "PREVIEW_FRAME": {
        const payload = lastMsg.payload;
        if (payload.image) {
          setPreviewImageSrc(payload.image);
        }
        break;
      }

      default:
        break;
    }
  }, [messages, games, newSourceType, activePreviewSource, newSourceName]);

  // Auto-scroll del chat integrado
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [chatMessages]);

  // Escuchar eventos nativos de Tauri (SysTray)
  useEffect(() => {
    let unlistenSwitch: (() => void) | null = null;
    let unlistenMic: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        unlistenSwitch = await listen<string>("tray_switch_game", (event) => {
          const gameTitle = event.payload;
          const found = games.find((g) => g.game_title === gameTitle);
          if (found) {
            handleSelectGame(found.profile_id, found.game_title);
          }
        });

        unlistenMic = await listen("tray_toggle_mic", () => {
          setIsMicActive((prev) => {
            const next = !prev;
            sendMessage("SAVE_SETTING", { key: "microphone_active", value: next ? 1 : 0 });
            return next;
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
  }, [games]);

  // --- Acciones de Configuración ---
  const handleSelectGame = (profile_id: string, game_title: string) => {
    setActiveGameId(profile_id);
    sendMessage("USER_SWITCH_GAME", {
      game_id: profile_id,
      name: game_title,
    });
    sendMessage("SAVE_SETTING", { key: "active_game_profile", value: profile_id });
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
      const overlayWin = await WebviewWindow.getByLabel("overlay");
      if (overlayWin) {
        if (passive) {
          await overlayWin.show();
          await invoke("set_hud_click_through", { ignore: true });
        } else {
          await overlayWin.hide();
        }
      }
      sendMessage("SAVE_SETTING", { key: "hud_passive", value: passive ? "true" : "false" });
      triggerToast(
        passive
          ? "HUD Pasivo (Click-through) activado. La ventana overlay es transparente y recibe datos en tiempo real."
          : "HUD Desactivado."
      );
      addSystemChat(passive ? "HUD en modo pasivo click-through activo." : "HUD ocultado.", "info");
    } catch (e) {
      console.error("Error setting HUD overlay window:", e);
      triggerToast("Error: No se pudo configurar el HUD.");
    }
  };

  // --- Controladores de Fuentes de Captura ---
  const handleOpenAddSourceModal = () => {
    setNewSourceName("");
    setShowAddSourceModal1(true);
  };

  const handleNextAddSourceModal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSourceName.trim()) return;

    setShowAddSourceModal1(false);
    setShowAddSourceModal2(true);
    setIsLoadingHardware(true);
    sendMessage("GET_HARDWARE_SOURCES", {});
  };

  const handleSourceTypeChange = (type: "monitor" | "window" | "camera") => {
    setNewSourceType(type);
  };

  const handleSaveCaptureSource = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSourceName.trim() || !newSourceTargetId) return;

    sendMessage("SAVE_CAPTURE_SOURCE", {
      name: newSourceName.trim(),
      type: newSourceType,
      target_id: newSourceTargetId,
    });
  };

  const handleDeleteCaptureSource = (name: string) => {
    if (activePreviewSource?.name === name) {
      handleStopPreview();
    }
    sendMessage("DELETE_CAPTURE_SOURCE", { name });
  };

  const handleTogglePreview = (source: CaptureSource) => {
    if (activePreviewSource?.name === source.name) {
      handleStopPreview();
    } else {
      setActivePreviewSource(source);
      setPreviewImageSrc(null);
      sendMessage("START_PREVIEW", {
        type: source.type,
        target_id: source.target_id,
      });
      sendMessage("SAVE_SETTING", { key: "active_capture_source", value: source.name });
    }
  };

  const handleStopPreview = () => {
    setActivePreviewSource(null);
    setPreviewImageSrc(null);
    sendMessage("STOP_PREVIEW", {});
    sendMessage("SAVE_SETTING", { key: "active_capture_source", value: "" });
  };

  const handlePreviewWidthChange = (width: number) => {
    setPreviewWidth(width);
    sendMessage("SAVE_SETTING", { key: "preview_width", value: width });
  };

  const handlePreviewJpegQualityChange = (quality: number) => {
    setPreviewJpegQuality(quality);
    sendMessage("SAVE_SETTING", { key: "preview_jpeg_quality", value: quality });
  };

  const handleBackToModal1 = () => {
    setShowAddSourceModal2(false);
    setShowAddSourceModal1(true);
  };

  // --- Simulación de Transcripción de Voz ---
  const handleSendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInputText.trim()) return;

    const userText = chatInputText.trim();
    const newMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: userText,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, newMsg]);
    setChatInputText("");

    setTimeout(() => {
      simulateRocoResponse(userText);
    }, 1200);
  };

  const simulateVoiceInput = () => {
    const userPhrases = [
      "Roco, haz un clip de los últimos 30 segundos y publícalo en Discord.",
      "Roco, ¿cuál es la debilidad elemental de este jefe?",
      "Roco, activa el filtro de reducción de ruido en el micrófono.",
      "Roco, lee la descripción del objeto seleccionado en el inventario.",
      "Roco, guarda este punto de control en Elden Ring.",
    ];
    const phrase = userPhrases[Math.floor(Math.random() * userPhrases.length)];
    const newMsg: ChatMessage = {
      id: `sim-user-${Date.now()}`,
      sender: "user",
      text: phrase,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, newMsg]);

    setTimeout(() => {
      simulateRocoResponse(phrase);
    }, 1500);
  };

  const simulateRocoResponse = (userPhrase: string) => {
    let reply = "Entendido. Procesando comando de voz asíncrono...";
    if (userPhrase.toLowerCase().includes("clip")) {
      reply =
        "Clip de video de 30 segundos generado en baja resolución. Guardado en la carpeta de capturas y enviado a Discord. Canal: #gaming-stream.";
    } else if (userPhrase.toLowerCase().includes("debilidad")) {
      reply =
        "Análisis de jefe completado: Su debilidad es el daño por FUEGO (Fire) y RAYO (Lightning). Te sugiero usar Grasa Ígnea en tu espada.";
    } else if (userPhrase.toLowerCase().includes("ruido")) {
      reply = "Filtro de reducción de ruido (Gate/Suppressor) activado localmente en el cliente.";
    } else if (
      userPhrase.toLowerCase().includes("inventario") ||
      userPhrase.toLowerCase().includes("objeto")
    ) {
      reply =
        "OCR procesado: El objeto seleccionado es 'Espada de Caballero'. Atributos: Fuerza D, Destreza D. Peso: 8.0.";
    } else if (
      userPhrase.toLowerCase().includes("control") ||
      userPhrase.toLowerCase().includes("guardar")
    ) {
      reply =
        "Punto de control registrado en SQLite. Metadata guardada bajo el perfil de juego activo actual.";
    }

    const newMsg: ChatMessage = {
      id: `sim-roco-${Date.now()}`,
      sender: "roco",
      text: reply,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, newMsg]);
  };

  // --- Controladores para arrastrar el Modal PIP ---
  const handlePipMouseDown = (e: React.MouseEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest(".drag-handle")) {
      setIsDraggingPip(true);
      dragOffsetRef.current = {
        x: e.clientX - pipPosition.x,
        y: e.clientY - pipPosition.y,
      };
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingPip) {
        setPipPosition({
          x: e.clientX - dragOffsetRef.current.x,
          y: e.clientY - dragOffsetRef.current.y,
        });
      }
    };
    const handleMouseUp = () => {
      setIsDraggingPip(false);
    };

    if (isDraggingPip) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPip]);

  if (windowLabel === "overlay") {
    return (
      <div className="h-screen w-screen bg-transparent overflow-hidden relative select-none pointer-events-none font-sans">
        {ocrData && ocrData.bbox && (
          <div
            className="absolute border-2 border-emerald-500 bg-emerald-500/5 shadow-[0_0_15px_rgba(16,185,129,0.4)] flex flex-col justify-end transition-all duration-200"
            style={{
              left: `${ocrData.bbox.x1 * 100}%`,
              top: `${ocrData.bbox.y1 * 100}%`,
              width: `${(ocrData.bbox.x2 - ocrData.bbox.x1) * 100}%`,
              height: `${(ocrData.bbox.y2 - ocrData.bbox.y1) * 100}%`,
            }}
          >
            {ocrData.text_raw && (
              <div className="absolute top-full left-0 mt-2 bg-slate-900/90 border border-emerald-500 px-3 py-1.5 rounded-lg text-xs text-emerald-400 font-mono max-w-xl shadow-[0_0_12px_rgba(16,185,129,0.2)] pointer-events-none animate-pulse">
                {ocrData.avatar_detected ? `[Avatar: ${ocrData.avatar_hash}] ` : ""}
                {ocrData.text_raw}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden flex flex-col select-none relative font-sans">
      {/* Notificación Flotante */}
      {toast && (
        <div className="absolute top-6 left-1/2 transform -translate-x-1/2 z-50 bg-gamer-panel border border-gamer-neonGreen text-gamer-neonGreen px-4 py-2.5 rounded-lg shadow-[0_0_20px_rgba(57,255,20,0.25)] flex items-center gap-3 animate-pulse">
          <div className="h-2 w-2 rounded-full bg-gamer-neonGreen shadow-glow shadow-gamer-neonGreen"></div>
          <span className="text-xs font-mono font-semibold uppercase tracking-wider">{toast}</span>
        </div>
      )}

      {/* Header Principal */}
      <header className="h-14 flex-none border-b border-slate-800/80 px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* LED de Conexión */}
          <div
            className={`h-3.5 w-3.5 rounded-full shadow-[0_0_10px] transition-all duration-300 ${
              status === "CONNECTED"
                ? "bg-gamer-neonGreen shadow-gamer-neonGreen animate-pulse"
                : status === "CONNECTING"
                ? "bg-gamer-neonYellow shadow-gamer-neonYellow animate-pulse"
                : "bg-red-500 shadow-red-500"
            }`}
          ></div>
          <div>
            <h1 className="text-base md:text-lg font-bold tracking-widest text-slate-100 font-mono uppercase">
              ROCO <span className="text-xs text-gamer-neonGreen">IA // PHASE 2.1</span>
            </h1>
            <p className="text-[9px] text-slate-500 font-mono -mt-1 tracking-widest">
              HYBRID COGNITION ENGINE
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Badge de WebSocket */}
          <div className="flex items-center gap-2 bg-gamer-panel border border-gamer-border px-3 py-1.5 rounded-lg">
            <span className="text-[9px] font-mono tracking-widest text-slate-500 uppercase">
              WS_LINK:
            </span>
            <span
              className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
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

          {/* Botón de Gestión API Keys */}
          <button
            onClick={() => setShowApiModal(true)}
            className="flex items-center gap-1.5 bg-gamer-panel border border-gamer-border hover:border-gamer-neonYellow/50 text-slate-300 hover:text-gamer-neonYellow text-xs font-mono px-3.5 py-1.5 rounded-lg transition-all cursor-pointer shadow-sm"
          >
            🔑 API KEYS
          </button>

          {/* Botón PIP / Ventana Flotante */}
          <button
            onClick={() => setShowFloatingPip(true)}
            className="flex items-center gap-1.5 bg-gamer-panel border border-gamer-border hover:border-gamer-neonGreen/50 text-slate-300 hover:text-gamer-neonGreen text-xs font-mono px-3.5 py-1.5 rounded-lg transition-all cursor-pointer shadow-sm"
          >
            📺 PIP WINDOW
          </button>
        </div>
      </header>

      {/* Grid Principal */}
      <main className="flex-grow flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 min-h-0 overflow-hidden">
        {/* COLUMNA IZQUIERDA: Live Preview, Fuentes de Captura y Mezclador */}
        <section className="lg:col-span-7 flex flex-col h-full min-h-0 gap-4">
          {/* 1. Live Preview Screen */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-800/80 p-3 flex flex-col gap-2 flex-none">
            <div className="flex justify-between items-center border-b border-gamer-border/60 pb-1.5">
              <h3 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                // TRANSMISIÓN EN VIVO
              </h3>
              {activePreviewSource && (
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-ping"></span>
                  <span className="text-[10px] font-mono text-red-500 uppercase tracking-widest font-bold">
                    LIVE: {activePreviewSource.name} (10 FPS)
                  </span>
                </div>
              )}
            </div>

            {/* Marco de visualización (16:9) */}
            <div ref={containerRef} className="flex-none aspect-video w-full bg-slate-900 rounded-lg border border-slate-800 relative overflow-hidden flex flex-col items-center justify-center">
              {isCalibrating && (
                <div
                  className="absolute inset-0 z-30 cursor-crosshair bg-black/40 select-none"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  {dragStart && dragEnd && (
                    <div
                      className="absolute border-2 border-dashed border-gamer-neonGreen bg-gamer-neonGreen/10"
                      style={getDragBoxStyle()}
                    />
                  )}
                  {roiBox && !dragStart && (
                    <div
                      className="absolute border-2 border-gamer-neonGreen bg-gamer-neonGreen/20 flex items-center justify-center"
                      style={getRoiBoxStyle()}
                    >
                      <span className="text-[10px] text-gamer-neonGreen font-mono bg-black/85 px-2 py-0.5 border border-gamer-neonGreen rounded shadow-md">
                        ZONA DE SUBTÍTULOS
                      </span>
                    </div>
                  )}
                  <div className="absolute top-2 left-2 bg-black/85 border border-gamer-neonGreen/40 text-slate-200 text-[10px] font-mono p-2 rounded max-w-[280px]">
                    💡 Haz click y arrastra el cursor para definir la zona de subtítulos.
                  </div>
                </div>
              )}
              {/* Pantalla CRT scanlines/grid */}
              <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[size:100%_4px,6px_100%] pointer-events-none z-10"></div>

              {previewImageSrc ? (
                <img
                  src={previewImageSrc}
                  alt="Live Preview Feed"
                  className="w-full h-full object-contain"
                />
              ) : (
                <>
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent via-gamer-neonGreen/5 to-transparent animate-scan pointer-events-none"></div>
                  <div className="flex flex-col items-center text-center gap-2 px-4 z-20">
                    <span className="text-xs font-mono text-slate-650 tracking-widest uppercase">
                      SIN SEÑAL // PREPARADO PARA CAPTURA
                    </span>
                    <span className="text-[10px] font-mono text-slate-700 max-w-[280px]">
                      Activa el botón [👁️ PREVIEW] de una fuente de captura OBS a continuación.
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Controles de Calidad y Resolución en Vivo */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1.5 border-t border-gamer-border/40 mt-1">
              {/* Calibración interactiva */}
              <div className="flex items-center gap-2">
                {isCalibrating ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (roiBox) {
                          sendMessage("SAVE_GAME_ZONE", roiBox);
                          setIsCalibrating(false);
                        } else {
                          triggerToast("Dibuja una caja primero.");
                        }
                      }}
                      className="px-2.5 py-1 rounded text-[10px] font-mono font-bold bg-gamer-neonGreen text-black hover:bg-gamer-neonGreen/80 transition-all cursor-pointer"
                    >
                      GUARDAR ZONA
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsCalibrating(false);
                        setDragStart(null);
                        setDragEnd(null);
                      }}
                      className="px-2.5 py-1 rounded text-[10px] font-mono font-bold bg-slate-700 text-slate-200 hover:bg-slate-600 transition-all cursor-pointer"
                    >
                      CANCELAR
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setIsCalibrating(true);
                      setRoiBox(null);
                    }}
                    className="px-2.5 py-1 rounded text-[10px] font-mono font-bold border border-gamer-neonGreen/30 text-gamer-neonGreen bg-gamer-neonGreen/5 hover:bg-gamer-neonGreen hover:text-black transition-all cursor-pointer"
                  >
                    ⚙️ CALIBRAR ZONA
                  </button>
                )}
              </div>
              {/* Resolución */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                  Resolución:
                </span>
                <div className="flex bg-gamer-dark border border-gamer-border rounded p-0.5 overflow-hidden">
                  {[480, 720, 1080, 0].map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => handlePreviewWidthChange(w)}
                      className={`px-2.5 py-0.5 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                        previewWidth === w
                          ? "bg-gamer-neonGreen text-black"
                          : "text-slate-500 hover:text-slate-350"
                      }`}
                    >
                      {w === 0 ? "Original" : w === 480 ? "480p" : w === 720 ? "720p" : "1080p"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Compresión JPEG */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                    Nitidez (Calidad):
                  </span>
                  <span className="text-[10px] font-mono text-gamer-neonGreen font-bold">
                    {previewJpegQuality}%
                  </span>
                </div>
                <input
                  type="range"
                  min="30"
                  max="100"
                  value={previewJpegQuality}
                  onChange={(e) => handlePreviewJpegQualityChange(Number(e.target.value))}
                  className="w-24 accent-gamer-neonGreen bg-gamer-dark border border-gamer-border rounded h-1 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Subgrid: OBS Sources y Mixer Vertical side-by-side */}
          <div className="flex-grow flex-1 grid grid-cols-2 gap-4 mt-4 min-h-0 overflow-hidden">
            {/* A: Capture Sources (7 Columnas) */}
            <div className="flex flex-col h-full bg-slate-900/50 rounded-lg border border-slate-800/80 p-3 min-h-0">
              <div className="flex justify-between items-center border-b border-gamer-border/60 pb-2">
                <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                  // FUENTES DE CAPTURA (OBS)
                </h2>
                <button
                  onClick={handleOpenAddSourceModal}
                  className="text-[10px] font-mono font-bold px-2 py-0.5 border border-gamer-neonGreen/30 text-gamer-neonGreen bg-gamer-neonGreen/5 hover:bg-gamer-neonGreen hover:text-black rounded transition-all cursor-pointer"
                >
                  + FUENTE
                </button>
              </div>

              <div className="space-y-2 overflow-y-auto flex-1 pr-1 custom-scrollbar">
                {sources.length === 0 ? (
                  <div className="text-center text-xs text-slate-650 italic py-8">
                    No hay fuentes registradas.
                  </div>
                ) : (
                  sources.map((src) => {
                    const isPreviewing = activePreviewSource?.name === src.name;
                    return (
                      <div
                        key={src.name}
                        className={`bg-gamer-dark border rounded-lg p-2.5 flex justify-between items-center text-xs transition-all duration-300 ${
                          isPreviewing
                            ? "border-gamer-neonGreen bg-gamer-neonGreen/5 shadow-[0_0_10px_rgba(57,255,20,0.1)]"
                            : "border-gamer-border hover:border-slate-800"
                        }`}
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-slate-500 font-mono uppercase">
                              {src.type === "camera"
                                ? "📷 CAM"
                                : src.type === "monitor"
                                ? "🖥️ MON"
                                : "🪟 WIN"}
                            </span>
                            <span className="font-bold text-slate-200 font-mono">{src.name}</span>
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => handleTogglePreview(src)}
                            className={`text-[9px] font-mono font-semibold px-2.5 py-1 rounded transition-colors cursor-pointer ${
                              isPreviewing
                                ? "bg-gamer-neonGreen text-black hover:bg-gamer-neonGreen/80"
                                : "bg-gamer-panel border border-gamer-border text-slate-400 hover:text-slate-200"
                            }`}
                          >
                            {isPreviewing ? "⏹" : "👁"}
                          </button>
                          <button
                            onClick={() => handleDeleteCaptureSource(src.name)}
                            className="text-[9px] bg-gamer-panel border border-gamer-border hover:border-red-500/50 text-slate-550 hover:text-red-400 px-2 py-1 rounded transition-colors cursor-pointer"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* B: Mezclador de Audio Vertical (5 Columnas) */}
            <div className="flex flex-col h-full bg-slate-900/50 rounded-lg border border-slate-800/80 p-3 min-h-0 justify-between gap-3">
              <div className="flex justify-between items-center border-b border-gamer-border/60 pb-2">
                <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                  // AUDIO MIXER
                </h2>
                <button
                  onClick={() => {
                    const nextState = !isMicActive;
                    setIsMicActive(nextState);
                    handleSaveSetting("microphone_active", nextState ? 1 : 0);
                  }}
                  className={`text-[9px] font-mono font-bold px-2 py-0.5 border rounded cursor-pointer transition-all ${
                    isMicActive
                      ? "border-gamer-neonGreen text-gamer-neonGreen bg-gamer-neonGreen/5 shadow-[0_0_8px_rgba(57,255,20,0.15)]"
                      : "border-gamer-border text-slate-500 hover:border-slate-700"
                  }`}
                >
                  {isMicActive ? "MUTE" : "UNMUTE"}
                </button>
              </div>

              {/* Contenedor Vúmetro Vertical + Controles */}
              <div className="flex flex-1 gap-4 items-center justify-center py-2 overflow-y-auto pr-1 custom-scrollbar">
                {/* Vúmetro Canvas Vertical */}
                <div className="flex flex-col items-center gap-1.5 h-full">
                  <div className="flex gap-1.5 items-stretch h-[140px]">
                    <canvas
                      ref={vuCanvasRef}
                      width={18}
                      height={140}
                      className="w-4.5 h-full bg-gamer-dark rounded border border-gamer-border/60"
                    />
                    <div className="flex flex-col justify-between text-[7px] text-slate-600 font-mono py-0.5 leading-none">
                      <span>0dB</span>
                      <span>-9dB</span>
                      <span>-20dB</span>
                      <span>-40dB</span>
                      <span>-60dB</span>
                    </div>
                  </div>
                </div>

                {/* Botón de configuración de micro */}
                <div className="flex flex-col gap-2 items-center justify-center">
                  <button
                    onClick={() => setShowMicModal(true)}
                    className="w-12 h-12 rounded-full border border-gamer-border bg-gamer-dark hover:border-gamer-neonGreen hover:text-gamer-neonGreen text-slate-355 text-xl flex items-center justify-center cursor-pointer transition-all shadow-md shadow-black/30 hover:scale-105"
                    title="Ajustes de Micrófono"
                  >
                    🎤
                  </button>
                  <span className="text-[8px] text-slate-500 font-mono text-center max-w-[80px] uppercase">
                    Ajustes de Micro
                  </span>
                  <div className="text-[9px] text-slate-400 font-mono font-bold bg-gamer-dark border border-gamer-border px-2 py-0.5 rounded-md mt-1">
                    {volume}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* COLUMNA DERECHA: Configuración de Voz y Consola Cognitiva Chat & Logs */}
        <section className="lg:col-span-5 flex flex-col h-full min-h-0 gap-4">
          {/* Tarjeta de Perfil e Idioma de Salida */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-800/80 p-3 flex flex-col gap-3 flex-none">
            <div className="flex justify-between items-center border-b border-gamer-border/60 pb-2">
              <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                // CONFIGURACIÓN DE VOZ
              </h2>
              <button
                onClick={() => setShowAddProfileModal(true)}
                className="text-[10px] font-mono font-bold px-2 py-0.5 border border-gamer-neonGreen/30 text-gamer-neonGreen bg-gamer-neonGreen/5 hover:bg-gamer-neonGreen hover:text-black rounded transition-all cursor-pointer"
              >
                + NUEVO JUEGO
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Selector de Juego */}
              <div>
                <label className="block text-[8px] text-slate-500 font-bold uppercase mb-1 font-mono">
                  PERFIL DE JUEGO
                </label>
                <div className="relative">
                  <select
                    value={activeGameId}
                    onChange={(e) => {
                      const selected = games.find((g) => g.profile_id === e.target.value);
                      if (selected) handleSelectGame(selected.profile_id, selected.game_title);
                    }}
                    className="w-full bg-gamer-dark border border-gamer-border p-2 rounded text-slate-200 text-xs focus:outline-none focus:border-gamer-neonGreen appearance-none font-mono cursor-pointer"
                  >
                    <option value="" disabled>
                      Selecciona...
                    </option>
                    {games.map((game) => (
                      <option key={game.profile_id} value={game.profile_id}>
                        {game.game_title}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-500 text-[10px]">
                    ▼
                  </div>
                </div>
              </div>

              {/* Selector de Idioma de Salida (Roco) */}
              <div>
                <label className="block text-[8px] text-slate-500 font-bold uppercase mb-1 font-mono">
                  IDIOMA NARRADOR (ROCO)
                </label>
                <select
                  value={outputLang}
                  onChange={(e) => {
                    setOutputLang(e.target.value);
                    handleSaveSetting("output_language", e.target.value);
                  }}
                  className="w-full bg-gamer-dark border border-gamer-border p-2 rounded text-slate-200 text-xs focus:outline-none focus:border-gamer-neonGreen font-mono cursor-pointer"
                >
                  <option value="es">Español (ES)</option>
                  <option value="en">Inglés (EN)</option>
                  <option value="pt">Portugués (PT)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Chat HUD Integrado con Logs de Red */}
          <div className="flex flex-col h-full bg-slate-900/50 rounded-lg border border-slate-800 p-4 min-h-0">
            <div className="flex justify-between items-center border-b border-gamer-border/60 pb-2 mb-3 flex-none">
              <h2 className="text-xs font-bold tracking-widest text-slate-400 uppercase font-mono">
                // CONSOLA COGNITIVA INTEGRADA (CHAT & LOGS)
              </h2>
            </div>

            {/* Ventana de mensajes integrada */}
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto min-h-0 pr-2 space-y-3 bg-gamer-dark/40 border border-gamer-border/40 rounded-lg custom-scrollbar">
              {chatMessages.length === 0 ? (
                <div className="text-slate-655 italic text-center pt-20 text-xs font-mono">
                  Esperando flujo de eventos o interacción de voz...
                </div>
              ) : (
                chatMessages.map((msg) => {
                  if (msg.sender === "system") {
                    const isExpanded = !!expandedLogIds[msg.id];
                    let bannerStyle = "bg-sky-950/30 border-sky-500/30 text-sky-400";
                    if (msg.type === "success") {
                      bannerStyle = "bg-emerald-950/30 border-emerald-500/30 text-gamer-neonGreen";
                    } else if (msg.type === "error") {
                      bannerStyle = "bg-red-950/30 border-red-500/30 text-red-400";
                    }

                    return (
                      <div key={msg.id} className="flex flex-col w-full my-2 px-2">
                        <div
                          className={`border rounded-lg px-3 py-2 text-[9px] font-mono flex items-center justify-between gap-3 ${bannerStyle}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-current"></span>
                            <span>{msg.text}</span>
                          </div>
                          {msg.payload && (
                            <button
                              onClick={() => toggleLogExpand(msg.id)}
                              className="px-2 py-0.5 border border-current/20 hover:border-current/50 rounded text-[8px] cursor-pointer transition-colors"
                            >
                              {isExpanded ? "OCULTAR JSON" : "VER JSON"}
                            </button>
                          )}
                        </div>
                        {isExpanded && msg.payload && (
                          <pre className="mt-1 bg-gamer-dark p-2 rounded-lg text-[8px] font-mono text-slate-450 border border-gamer-border overflow-x-auto whitespace-pre-wrap break-all">
                            {JSON.stringify(msg.payload, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  }

                  const isUser = msg.sender === "user";
                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isUser ? "justify-end" : "justify-start"} px-2`}
                    >
                      <div className={`flex flex-col max-w-[85%] gap-1`}>
                        <div
                          className={`flex items-center gap-1.5 text-[9px] text-slate-500 font-mono ${
                            isUser ? "justify-end" : "justify-start"
                          }`}
                        >
                          <span>{isUser ? "🎤 USER VOICE" : "🤖 ROCO IA"}</span>
                          <span>•</span>
                          <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>

                        <div
                          className={`rounded-xl px-3 py-2 text-xs font-mono leading-relaxed select-text ${
                            isUser
                              ? "bg-gamer-neonGreen/5 border border-gamer-neonGreen/30 text-slate-200 rounded-tr-none shadow-[0_0_12px_rgba(57,255,20,0.03)]"
                              : "bg-gamer-panel border border-gamer-border text-slate-100 rounded-tl-none shadow-[0_0_12px_rgba(255,255,255,0.01)]"
                          }`}
                        >
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Formulario e inputs de simulación */}
            <div className="flex flex-col gap-2 flex-none mt-3 border-t border-slate-800 pt-3">
              <form onSubmit={handleSendChatMessage} className="flex gap-2">
                <input
                  type="text"
                  placeholder="Escribe un mensaje para Roco o simula voz..."
                  value={chatInputText}
                  onChange={(e) => setChatInputText(e.target.value)}
                  className="flex-1 bg-gamer-dark border border-gamer-border rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-gamer-neonGreen font-mono"
                />
                <button
                  type="submit"
                  className="bg-gamer-neonGreen text-black font-bold text-xs px-4 rounded-lg hover:bg-gamer-neonGreen/80 transition-colors cursor-pointer font-mono"
                >
                  ENVIAR
                </button>
              </form>

              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={simulateVoiceInput}
                  className="bg-gamer-panel border border-gamer-neonGreen/20 hover:border-gamer-neonGreen/50 text-gamer-neonGreen text-[9px] font-mono font-bold py-1.5 rounded-lg transition-all cursor-pointer"
                >
                  🎤 SIMULAR VOZ
                </button>
                <button
                  onClick={() =>
                    simulateRocoResponse("Roco, ¿cuál es la debilidad elemental de este jefe?")
                  }
                  className="bg-gamer-panel border border-gamer-neonYellow/20 hover:border-gamer-neonYellow/50 text-gamer-neonYellow text-[9px] font-mono font-bold py-1.5 rounded-lg transition-all cursor-pointer"
                >
                  🤖 SIMULAR ROCO
                </button>
                <button
                  onClick={() => {
                    setChatMessages([]);
                    clearMessages();
                  }}
                  className="bg-gamer-panel border border-red-500/20 hover:border-red-500/40 text-red-400 text-[9px] font-mono font-bold py-1.5 rounded-lg transition-all cursor-pointer"
                >
                  🗑️ LIMPIAR TODO
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* --- MODAL 1: REGISTRAR JUEGO --- */}
      {showAddProfileModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
          <div className="bg-gamer-panel border border-gamer-border rounded-xl max-w-sm w-full p-5 shadow-2xl relative">
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
                  className="w-full bg-gamer-dark border border-gamer-border rounded p-2 text-slate-200 focus:outline-none focus:border-gamer-neonGreen"
                />
              </div>

              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  Título Público (Ej: Zelda: Tears of the Kingdom)
                </label>
                <input
                  type="text"
                  required
                  placeholder="ej: Zelda: Tears of the Kingdom"
                  value={newProfileTitle}
                  onChange={(e) => setNewProfileTitle(e.target.value)}
                  className="w-full bg-gamer-dark border border-gamer-border rounded p-2 text-slate-200 focus:outline-none focus:border-gamer-neonGreen"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddProfileModal(false)}
                  className="flex-1 py-2 border border-gamer-border hover:border-slate-700 rounded text-slate-500 hover:text-slate-300 cursor-pointer font-bold uppercase"
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-gamer-neonGreen text-black font-bold rounded hover:bg-gamer-neonGreen/80 cursor-pointer uppercase"
                >
                  REGISTRAR
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL DE GESTIÓN API KEYS --- */}
      {showApiModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
          <div className="bg-gamer-panel border border-gamer-border rounded-xl max-w-lg w-full p-5 shadow-2xl relative flex flex-col max-h-[90vh]">
            <button
              onClick={() => setShowApiModal(false)}
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-355 text-sm font-semibold cursor-pointer"
            >
              ✕
            </button>

            <h3 className="text-xs font-bold tracking-widest text-slate-200 uppercase mb-4 font-mono">
              // GEMINI API KEYS (CREDENCIALES DE IA)
            </h3>

            {/* Formulario de registro */}
            <form onSubmit={handleAddApiKey} className="flex gap-2 mb-4">
              <input
                type="password"
                placeholder="Introduce tu Gemini API Key..."
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                className="flex-1 bg-gamer-dark border border-gamer-border rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-gamer-neonGreen font-mono"
              />
              <button
                type="submit"
                className="bg-gamer-neonGreen text-black font-bold text-xs px-4 rounded hover:bg-gamer-neonGreen/80 transition-colors cursor-pointer font-mono"
              >
                REGISTRAR
              </button>
            </form>

            {/* Listado de claves */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {apiKeys.length === 0 ? (
                <div className="text-center text-xs text-slate-650 italic py-6 font-mono">
                  No hay llaves de API Gemini registradas en SQLite.
                </div>
              ) : (
                apiKeys.map((key) => (
                  <div
                    key={key.id}
                    className="bg-gamer-dark border border-gamer-border rounded-lg p-3 flex justify-between items-center text-xs"
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-slate-300">
                        ID: {key.id} // {key.key_value.substring(0, 15)}...
                      </span>
                      <div className="flex gap-2.5 text-[9px] font-mono">
                        <span
                          className={key.active ? "text-gamer-neonGreen" : "text-red-500 font-bold"}
                        >
                          {key.active ? "ESTADO: ACTIVA" : "ESTADO: DESACTIVADA"}
                        </span>
                        <span className="text-slate-605">INTENTOS FALLIDOS: {key.failed_attempts}/3</span>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleTestApiKey(key.id, key.key_value)}
                        disabled={!key.active}
                        className={`text-[9px] font-mono font-bold px-2.5 py-1 rounded transition-colors ${
                          key.active
                            ? "bg-gamer-panel border border-gamer-border text-gamer-neonYellow hover:bg-gamer-neonYellow hover:text-black cursor-pointer"
                            : "bg-gamer-dark text-slate-655 border border-transparent cursor-not-allowed"
                        }`}
                      >
                        TEST
                      </button>
                      <button
                        onClick={() => handleDeactivateApiKey(key.id)}
                        disabled={!key.active}
                        className={`text-[9px] font-mono font-bold px-2.5 py-1 rounded transition-colors ${
                          key.active
                            ? "bg-gamer-panel border border-gamer-border text-red-400 hover:bg-red-500 hover:text-white cursor-pointer"
                            : "bg-gamer-dark text-slate-655 border border-transparent cursor-not-allowed"
                        }`}
                      >
                        DEACTIVAR
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="pt-4 border-t border-gamer-border/60 mt-4 flex justify-end">
              <button
                onClick={() => setShowApiModal(false)}
                className="bg-gamer-dark border border-gamer-border hover:border-slate-600 text-slate-400 hover:text-slate-200 text-xs font-mono px-4 py-2 rounded-lg cursor-pointer"
              >
                CERRAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL DEDICADO DE CONFIGURACIÓN DE MICRÓFONO --- */}
      {showMicModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
          <div className="bg-gamer-panel border border-gamer-border rounded-xl max-w-sm w-full p-5 shadow-2xl relative">
            <button
              onClick={() => setShowMicModal(false)}
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-350 text-sm font-semibold cursor-pointer"
            >
              ✕
            </button>

            <h3 className="text-xs font-bold tracking-widest text-slate-200 uppercase mb-4 font-mono">
              // AJUSTES DE MICRÓFONO
            </h3>

            <div className="space-y-4 font-mono text-xs">
              {/* Mic device selector */}
              <div>
                <label className="block text-slate-500 font-semibold mb-1.5 uppercase">
                  DISPOSITIVO ACTIVO
                </label>
                <select
                  value={activeMic}
                  onChange={(e) => {
                    const val = e.target.value;
                    setActiveMic(val);
                    handleSaveSetting("active_mic", val);
                  }}
                  className="w-full bg-gamer-dark border border-gamer-border p-2.5 rounded text-slate-200 text-xs focus:outline-none focus:border-gamer-neonGreen cursor-pointer"
                >
                  <option value="" disabled>
                    Selecciona un micrófono...
                  </option>
                  {browserAudioDevices.map((d, index) => (
                    <option key={d.deviceId || index} value={d.label}>
                      {d.label || `Micrófono ${index + 1}`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Vertical Gain Slider */}
              <div className="flex flex-col items-center gap-2 py-4 bg-gamer-dark border border-gamer-border rounded-xl">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                  GANANCIA DE CANAL
                </span>
                <div className="relative h-32 flex items-center justify-center my-1">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setVolume(val);
                      sendMessage("SAVE_SETTING", { key: "volume", value: val });
                    }}
                    style={{ writingMode: "vertical-lr", direction: "rtl" }}
                    className="h-28 w-2.5 bg-gamer-panel rounded-lg appearance-none cursor-pointer accent-gamer-neonGreen"
                  />
                </div>
                <div className="text-xs font-mono font-bold text-gamer-neonGreen">
                  {volume}%
                </div>
              </div>

              <div className="pt-2">
                <button
                  onClick={() => setShowMicModal(false)}
                  className="w-full py-2.5 bg-gamer-neonGreen text-black font-bold rounded hover:bg-gamer-neonGreen/80 cursor-pointer uppercase text-xs"
                >
                  GUARDAR AJUSTES
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- SECUENCIA MODALES FUENTES CAPTURA (OBS) --- */}
      {/* MODAL FUENTE 1: Nombre */}
      {showAddSourceModal1 && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
          <div className="bg-gamer-panel border border-gamer-border rounded-xl max-w-sm w-full p-5 shadow-2xl relative">
            <button
              onClick={() => setShowAddSourceModal1(false)}
              className="absolute top-4 right-4 text-slate-500 hover:text-slate-350 text-sm font-semibold cursor-pointer"
            >
              ✕
            </button>

            <h3 className="text-xs font-bold tracking-widest text-slate-200 uppercase mb-4 font-mono">
              // AÑADIR FUENTE (PASO 1)
            </h3>

            <form onSubmit={handleNextAddSourceModal} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  Nombre Personalizado
                </label>
                <div className="flex gap-2 mb-2">
                  <select
                    onChange={(e) => setNewSourceName(e.target.value)}
                    className="bg-gamer-dark border border-gamer-border rounded p-2 text-slate-300 text-xs focus:outline-none focus:border-gamer-neonGreen cursor-pointer"
                  >
                    <option value="">-- Elige un Perfil Rápido --</option>
                    <option value="Juego Principal">Juego Principal</option>
                    <option value="Cámara Gamer">Cámara Gamer</option>
                    <option value="Escritorio Completo">Escritorio Completo</option>
                    <option value="Ventana de Discord">Ventana de Discord</option>
                  </select>
                </div>
                <input
                  type="text"
                  required
                  placeholder="ej: Monitor Primario"
                  value={newSourceName}
                  onChange={(e) => setNewSourceName(e.target.value)}
                  className="w-full bg-gamer-dark border border-gamer-border rounded p-2.5 text-slate-200 focus:outline-none focus:border-gamer-neonGreen"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddSourceModal1(false)}
                  className="flex-1 py-2 border border-gamer-border hover:border-slate-700 rounded text-slate-550 hover:text-slate-300 cursor-pointer font-bold uppercase"
                >
                  CANCELAR
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-gamer-neonGreen text-black font-bold rounded hover:bg-gamer-neonGreen/80 cursor-pointer uppercase"
                >
                  SIGUIENTE
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL FUENTE 2: Configuración del Dispositivo (Hardware real de Python) */}
      {showAddSourceModal2 && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]">
          <div className="bg-gamer-panel border border-gamer-border rounded-xl max-w-md w-full p-5 shadow-2xl relative">
            <button
              onClick={() => setShowAddSourceModal2(false)}
              className="absolute top-4 right-4 text-slate-505 hover:text-slate-300 text-sm font-semibold cursor-pointer"
            >
              ✕
            </button>

            <h3 className="text-xs font-bold tracking-widest text-slate-200 uppercase mb-4 font-mono">
              // DETECTAR HARDWARE (PASO 2)
            </h3>

            <form onSubmit={handleSaveCaptureSource} className="space-y-4 text-xs font-mono">
              {/* Type selector */}
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  TIPO DE CAPTURA
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(["monitor", "window", "camera"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleSourceTypeChange(t)}
                      className={`py-2 px-1 border rounded font-bold uppercase transition-all cursor-pointer ${
                        newSourceType === t
                          ? "border-gamer-neonGreen text-gamer-neonGreen bg-gamer-neonGreen/5"
                          : "border-gamer-border text-slate-500 hover:border-slate-700"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Target Selector */}
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase">
                  DISPOSITIVO DE SISTEMA (BACKEND DETECTED)
                </label>

                {isLoadingHardware ? (
                  <div className="text-center py-4 bg-gamer-dark border border-gamer-border rounded text-slate-550 text-[10px] animate-pulse">
                    ESCANEANDO DISPOSITIVOS DE HARDWARE EN PYTHON...
                  </div>
                ) : (
                  <select
                    value={newSourceTargetId}
                    onChange={(e) => setNewSourceTargetId(e.target.value)}
                    required
                    className="w-full bg-gamer-dark border border-gamer-border p-2.5 rounded text-slate-200 text-xs focus:outline-none focus:border-gamer-neonGreen font-mono cursor-pointer"
                  >
                    <option value="" disabled>
                      Selecciona un objetivo...
                    </option>
                    {newSourceType === "camera" &&
                      (hardwareSources.usb_devices.length > 0 ? hardwareSources.usb_devices : hardwareSources.cameras).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    {newSourceType === "monitor" &&
                      hardwareSources.monitors.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    {newSourceType === "window" &&
                      hardwareSources.windows.map((w) => (
                        <option key={w.id} value={w.id}>
                          {(w.title || w.name || "").substring(0, 50)}
                        </option>
                      ))}
                  </select>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleBackToModal1}
                  className="flex-1 py-2 border border-gamer-border hover:border-slate-700 rounded text-slate-550 hover:text-slate-300 cursor-pointer font-bold uppercase"
                >
                  ATRÁS
                </button>
                <button
                  type="submit"
                  disabled={isLoadingHardware || !newSourceTargetId}
                  className={`flex-1 py-2 font-bold rounded uppercase ${
                    isLoadingHardware || !newSourceTargetId
                      ? "bg-slate-800 text-slate-505 cursor-not-allowed"
                      : "bg-gamer-neonGreen text-black hover:bg-gamer-neonGreen/80 cursor-pointer"
                  }`}
                >
                  GUARDAR FUENTE
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- REPRODUCTOR FLOTANTE MODAL (PIP) CON SOPORTE CLICK-THROUGH --- */}
      {showFloatingPip && (
        <div
          ref={pipContainerRef}
          onMouseDown={handlePipMouseDown}
          style={{
            position: "fixed",
            left: `${pipPosition.x}px`,
            top: `${pipPosition.y}px`,
          }}
          className={`w-80 border rounded-xl shadow-2xl z-50 p-3 flex flex-col gap-2 transition-all duration-300 ${
            isHudPassive
              ? "opacity-35 backdrop-blur-none bg-black/15 text-slate-400 border-dashed border-gamer-border/40 select-none pointer-events-none"
              : "bg-gamer-panel border-gamer-border text-slate-300"
          }`}
        >
          {/* Header del PIP con drag handle */}
          <div className="flex justify-between items-center border-b border-gamer-border/60 pb-1.5 cursor-move drag-handle">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold font-mono tracking-widest text-slate-400">
                ROCO PIP FEED
              </span>
            </div>
            {!isHudPassive && (
              <button
                onClick={() => setShowFloatingPip(false)}
                className="text-slate-505 hover:text-slate-300 text-xs font-semibold cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          {/* Mini Live Preview */}
          <div className="flex-none aspect-video w-full bg-slate-900 rounded-lg border border-slate-800 relative overflow-hidden flex flex-col items-center justify-center">
            {previewImageSrc ? (
              <img
                src={previewImageSrc}
                alt="Mini Live Feed"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="text-[9px] font-mono text-slate-600 text-center">
                SIN SEÑAL DE VÍDEO
              </div>
            )}
          </div>

          {/* Mini Vúmetro e Info */}
          <div className="flex gap-2 items-center bg-gamer-dark/50 border border-gamer-border/40 p-2 rounded-lg justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase">VÚMETRO RETINA</span>
            <div className="h-4 flex items-center gap-1">
              <canvas
                ref={pipVuCanvasRef}
                width={120}
                height={8}
                className="w-24 h-2 bg-gamer-dark rounded border border-gamer-border/60"
              />
            </div>
          </div>

          {/* Mini Chat unificado (últimos 3 mensajes) */}
          <div className="h-24 bg-gamer-dark/60 rounded-lg p-2 overflow-y-auto space-y-1 text-[9px] font-mono border border-gamer-border/30">
            {chatMessages.slice(-3).map((msg) => (
              <div key={msg.id} className="flex flex-col gap-0.5">
                <span className="text-[8px] text-slate-500">
                  {msg.sender === "user" ? "🎤 USER" : msg.sender === "system" ? "⚙️ SYS" : "🤖 ROCO"}
                </span>
                <span className="text-slate-300 leading-normal">{msg.text}</span>
              </div>
            ))}
          </div>

          {/* Modo HUD Switch y Advertencia */}
          <div className="flex flex-col gap-2 pt-1 border-t border-gamer-border/40">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-mono text-slate-400 uppercase">MODO CLICK-THROUGH</span>
              <button
                onClick={() => handleToggleHudMode(!isHudPassive)}
                className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                  isHudPassive ? "bg-gamer-neonYellow" : "bg-slate-700"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-gamer-dark transition-transform ${
                    isHudPassive ? "translate-x-3" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {isHudPassive && (
              <p className="text-[7.5px] text-gamer-neonYellow font-mono leading-normal animate-pulse text-center bg-black/40 p-1.5 rounded-lg border border-gamer-neonYellow/20 select-none">
                HUD Pasivo. Restablecer desde el menú SysTray nativo clic derecho: "Abrir Panel".
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
