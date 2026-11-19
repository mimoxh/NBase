package app.nbase.android

import org.junit.Assert.assertEquals
import org.junit.Test

class NavigationPolicyTest {
    private val origin = "https://nbase.example.com"

    @Test
    fun keepsTheServerInsideTheApp() {
        assertEquals(Navigation.IN_APP, NavigationPolicy.decide("https://nbase.example.com/#invite=x", origin, true))
        assertEquals(Navigation.IN_APP, NavigationPolicy.decide("https://nbase.example.com/api/attachments/1", origin, false))
    }

    @Test
    fun sendsOtherWebLinksToTheBrowser() {
        assertEquals(Navigation.EXTERNAL, NavigationPolicy.decide("https://example.org/", origin, true))
        assertEquals(Navigation.EXTERNAL, NavigationPolicy.decide("http://nbase.example.com/", origin, true))
        assertEquals(Navigation.EXTERNAL, NavigationPolicy.decide("https://nbase.example.com:8443/", origin, true))
        assertEquals(Navigation.EXTERNAL, NavigationPolicy.decide("mailto:a@example.org", origin, true))
    }

    @Test
    fun blocksForeignSubframesAndDangerousSchemes() {
        assertEquals(Navigation.BLOCK, NavigationPolicy.decide("https://example.org/", origin, false))
        assertEquals(Navigation.BLOCK, NavigationPolicy.decide("javascript:alert(1)", origin, true))
        assertEquals(Navigation.BLOCK, NavigationPolicy.decide("intent://x#Intent;end", origin, true))
        assertEquals(Navigation.BLOCK, NavigationPolicy.decide("file:///etc/hosts", origin, true))
        assertEquals(Navigation.BLOCK, NavigationPolicy.decide("about:blank", origin, true))
    }
}
