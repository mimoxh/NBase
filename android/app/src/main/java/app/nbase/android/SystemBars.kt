package app.nbase.android

import android.graphics.drawable.ColorDrawable
import android.view.View
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

object SystemBars {
    /** Draws behind the bars on every API level, then pads [root] for bars, cutouts and the keyboard. */
    fun install(window: Window, root: View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /** Colors the area behind the transparent bars and picks icon contrast to match. */
    fun setBackground(window: Window, argb: Int) {
        window.setBackgroundDrawable(ColorDrawable(argb))
        val light = CssColor.isLight(argb)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
    }
}
