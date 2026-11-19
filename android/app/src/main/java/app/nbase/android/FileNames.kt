package app.nbase.android

object FileNames {
    private val unsafe = Regex("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]")
    private const val MAX_LENGTH = 120

    fun sanitize(name: String): String {
        var value = unsafe.replace(name, "_").trim().trim('.', ' ')
        if (value.isEmpty()) return "download"
        if (value.length > MAX_LENGTH) {
            val dot = value.lastIndexOf('.')
            val extension = if (dot > 0 && value.length - dot <= 16) value.substring(dot) else ""
            var stem = value.substring(0, MAX_LENGTH - extension.length)
            if (stem.lastOrNull()?.isHighSurrogate() == true) stem = stem.dropLast(1)
            value = stem + extension
        }
        return value
    }

    fun extension(name: String): String {
        val dot = name.lastIndexOf('.')
        return if (dot in 1 until name.length - 1) name.substring(dot + 1).lowercase() else ""
    }
}
