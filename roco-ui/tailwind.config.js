/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                gamer: {
                    dark: '#0a0b0d',     // Fondo principal ultra oscuro
                    panel: '#121418',    // Fondo de paneles y tarjetas
                    border: '#1f242e',   // Bordes divisorios refinados
                    neonGreen: '#39ff14',// Verde neón de actividad principal
                    neonYellow: '#ffea00'// Amarillo de advertencia/micrófono continuo
                }
            }
        },
    },
    plugins: [],
}