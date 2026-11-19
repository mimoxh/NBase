package app.nbase.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNamesTest {
    @Test
    fun replacesPathAndReservedCharacters() {
        assertEquals("a_b_c.md", FileNames.sanitize("a/b\\c.md"))
        assertEquals("_etc_passwd", FileNames.sanitize("../etc/passwd"))
        assertEquals("会议_记录.zip", FileNames.sanitize("会议:记录.zip"))
        assertEquals("download", FileNames.sanitize(" . "))
    }

    @Test
    fun keepsTheExtensionWhenShortening() {
        val name = FileNames.sanitize("页".repeat(200) + ".docx")
        assertEquals(120, name.length)
        assertTrue(name.endsWith(".docx"))
        val emoji = FileNames.sanitize("😀".repeat(80))
        assertTrue(emoji.length <= 120 && !emoji.last().isHighSurrogate())
    }

    @Test
    fun extractsExtensions() {
        assertEquals("md", FileNames.extension("笔记.MD"))
        assertEquals("", FileNames.extension("README"))
        assertEquals("", FileNames.extension(".hidden"))
    }
}
