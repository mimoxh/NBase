package app.nbase.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CssColorTest {
    @Test
    fun parsesComputedColors() {
        assertEquals(0xFFFFFFFF.toInt(), CssColor.parse("#ffffff"))
        assertEquals(0xFF17181A.toInt(), CssColor.parse(" #17181a "))
        assertEquals(0xFFAABBCC.toInt(), CssColor.parse("#abc"))
        assertEquals(0xFFF7F7F5.toInt(), CssColor.parse("rgb(247, 247, 245)"))
        assertEquals(0xFF010203.toInt(), CssColor.parse("rgba(1, 2, 3, 1)"))
        assertEquals(0xFF010203.toInt(), CssColor.parse("rgb(1 2 3 / 100%)"))
    }

    @Test
    fun ignoresTransparentAndInvalidColors() {
        assertNull(CssColor.parse("rgba(0, 0, 0, 0)"))
        assertNull(CssColor.parse("rgb(1 2 3 / 50%)"))
        assertNull(CssColor.parse("rgb(300, 0, 0)"))
        assertNull(CssColor.parse("var(--x)"))
        assertNull(CssColor.parse(""))
    }

    @Test
    fun picksIconContrastForNBaseThemes() {
        assertTrue(CssColor.isLight(0xFFFFFFFF.toInt()))
        assertFalse(CssColor.isLight(0xFF17181A.toInt()))
    }
}
