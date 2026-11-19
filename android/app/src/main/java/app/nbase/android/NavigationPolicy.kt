package app.nbase.android

import java.util.Locale

enum class Navigation { IN_APP, EXTERNAL, BLOCK }

object NavigationPolicy {
    private val externalSchemes = setOf("http", "https", "mailto", "tel")

    /**
     * Only the configured server may load inside the app. Other web links go to the system browser from the
     * main frame and are blocked in subframes, so no third-party page ever sees the bridge or the session.
     */
    fun decide(url: String, origin: String, mainFrame: Boolean): Navigation {
        if (ServerAddress.originOf(url) == origin) return Navigation.IN_APP
        if (!mainFrame) return Navigation.BLOCK
        val scheme = url.substringBefore(':', "").lowercase(Locale.ROOT)
        return if (scheme in externalSchemes) Navigation.EXTERNAL else Navigation.BLOCK
    }
}
