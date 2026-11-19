package app.nbase.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PickedFilesTest {
    @Test
    fun reportsWhyFilesAreMissing() {
        assertEquals(PickProblem.NONE_RETURNED, PickedFiles.problem(0, 0))
        assertEquals(PickProblem.ALL_UNREADABLE, PickedFiles.problem(2, 0))
        assertEquals(PickProblem.SOME_UNREADABLE, PickedFiles.problem(3, 1))
    }

    @Test
    fun staysQuietWhenEveryFileIsReadable() {
        assertNull(PickedFiles.problem(1, 1))
        assertNull(PickedFiles.problem(4, 4))
    }
}
