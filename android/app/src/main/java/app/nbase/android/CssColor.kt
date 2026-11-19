package app.nbase.android

object CssColor {
    private val hex = Regex("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
    private val rgb = Regex("^rgba?\\(\\s*(\\d{1,3})[\\s,]+(\\d{1,3})[\\s,]+(\\d{1,3})(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$")

    /** Parses the colors `getComputedStyle` reports as an opaque ARGB int; transparent colors return null. */
    fun parse(value: String): Int? {
        val text = value.trim()
        hex.matchEntire(text)?.let { match ->
            val digits = match.groupValues[1].let { if (it.length == 3) it.map { c -> "$c$c" }.joinToString("") else it }
            return (0xFF shl 24) or digits.toInt(16)
        }
        val match = rgb.matchEntire(text) ?: return null
        val (r, g, b) = match.groupValues.subList(1, 4).map { it.toInt() }
        if (r > 255 || g > 255 || b > 255) return null
        val alpha = match.groupValues[4]
        if (alpha.isNotEmpty()) {
            val a = if (alpha.endsWith('%')) alpha.dropLast(1).toDoubleOrNull()?.div(100) else alpha.toDoubleOrNull()
            if (a == null || a < 1.0) return null
        }
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    /** True when dark system bar icons are readable on [argb] (WCAG relative luminance). */
    fun isLight(argb: Int): Boolean {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.04045) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) > 0.4
    }
}
