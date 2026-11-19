package app.nbase.android

import android.content.Context

class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("nbase_server", Context.MODE_PRIVATE)

    /** Re-validated on read so an address saved under an older, looser rule is not used. */
    var origin: String?
        get() = (prefs.getString(KEY_ORIGIN, null)?.let(ServerAddress::parse) as? ServerAddressResult.Valid)?.origin
        set(value) {
            prefs.edit().apply { if (value == null) remove(KEY_ORIGIN) else putString(KEY_ORIGIN, value) }.apply()
        }

    private companion object {
        const val KEY_ORIGIN = "origin"
    }
}
