package app.nbase.android

/** Why a completed system file pick handed fewer files to the page than the user chose. */
enum class PickProblem { NONE_RETURNED, ALL_UNREADABLE, SOME_UNREADABLE }

object PickedFiles {
    fun problem(returned: Int, readable: Int): PickProblem? = when {
        returned == 0 -> PickProblem.NONE_RETURNED
        readable == 0 -> PickProblem.ALL_UNREADABLE
        readable < returned -> PickProblem.SOME_UNREADABLE
        else -> null
    }
}
