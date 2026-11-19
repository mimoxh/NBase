package app.nbase.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun valid(input: String) = (ServerAddress.parse(input) as ServerAddressResult.Valid).origin
    private fun invalid(input: String) = ServerAddress.parse(input) is ServerAddressResult.Invalid

    @Test
    fun normalizesHttpsOrigins() {
        assertEquals("https://nbase.example.com", valid("https://NBase.Example.com"))
        assertEquals("https://nbase.example.com", valid("https://nbase.example.com/"))
        assertEquals("https://nbase.example.com", valid("https://nbase.example.com:443"))
        assertEquals("https://nbase.example.com:8443", valid("  https://nbase.example.com:8443  "))
        assertEquals("https://192.168.1.10:3001", valid("https://192.168.1.10:3001"))
        assertEquals("https://[fd00::1]:3001", valid("https://[fd00::1]:3001"))
    }

    @Test
    fun defaultsToHttpsExceptForLoopback() {
        assertEquals("https://nas.lan:3001", valid("nas.lan:3001"))
        assertEquals("http://localhost:3001", valid("localhost:3001"))
        assertEquals("http://127.0.0.1:3001", valid("127.0.0.1:3001"))
    }

    @Test
    fun allowsHttpOnlyOnTheServersLoopbackHosts() {
        assertEquals("http://localhost:3001", valid("http://localhost:3001"))
        assertEquals("http://127.0.0.1", valid("http://127.0.0.1:80"))
        assertTrue(invalid("http://192.168.1.10:3001"))
        assertTrue(invalid("http://nbase.example.com"))
        assertTrue(invalid("http://127.0.0.2:3001"))
        assertTrue(invalid("http://[::1]:3001"))
    }

    @Test
    fun rejectsAnythingButAnOrigin() {
        assertTrue(invalid(""))
        assertTrue(invalid("https://nbase.example.com/app"))
        assertTrue(invalid("https://nbase.example.com/?a=1"))
        assertTrue(invalid("https://nbase.example.com/#x"))
        assertTrue(invalid("https://user:pw@nbase.example.com"))
        assertTrue(invalid("ftp://nbase.example.com"))
        assertTrue(invalid("javascript:alert(1)"))
        assertTrue(invalid("https://nbase example.com"))
        assertTrue(invalid("https://nbase.example.com:70000"))
        assertTrue(invalid("https://"))
    }

    @Test
    fun originOfMatchesParseOutput() {
        assertEquals("https://nbase.example.com", ServerAddress.originOf("https://NBASE.example.com:443/a/b?c#d"))
        assertEquals("http://127.0.0.1:3001", ServerAddress.originOf("http://127.0.0.1:3001/api/health"))
        assertEquals("https://nbase.example.com", ServerAddress.originOf("blob:https://nbase.example.com/4f7c"))
        assertEquals("https://nbase.example.com", ServerAddress.originOf("https://nbase.example.com/页面#标题"))
        assertNull(ServerAddress.originOf("https://user@nbase.example.com/"))
        assertNull(ServerAddress.originOf("intent://scan/#Intent;scheme=zxing;end"))
        assertNull(ServerAddress.originOf("about:blank"))
        assertNull(ServerAddress.originOf("file:///sdcard/a.html"))
    }
}
