package app.nbase.android

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

sealed interface ServerAddressResult {
    data class Valid(val origin: String) : ServerAddressResult
    data class Invalid(val message: String) : ServerAddressResult
}

object ServerAddress {
    /** Mirrors `publicOriginConfig` on the server, which accepts plain HTTP only on these loopback hosts. */
    private val httpHosts = setOf("localhost", "127.0.0.1")
    private val originPrefix = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)")

    /** Normalizes user input to the exact origin string the server's NBASE_PUBLIC_ORIGIN must equal. */
    fun parse(input: String): ServerAddressResult {
        val text = input.trim()
        if (text.isEmpty()) return ServerAddressResult.Invalid("请输入服务器地址")
        if (text.any { it.isWhitespace() || it.isISOControl() }) return ServerAddressResult.Invalid("地址不能包含空格")
        val explicitScheme = text.contains("://")
        val uri = parseUri(if (explicitScheme) text else "https://$text")
            ?: return ServerAddressResult.Invalid("地址格式不正确")
        var scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "https" && scheme != "http") return ServerAddressResult.Invalid("只支持 https:// 地址")
        if (uri.rawUserInfo != null) return ServerAddressResult.Invalid("地址不能包含用户名或密码")
        val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
            ?: return ServerAddressResult.Invalid("主机名无效")
        val path = uri.rawPath.orEmpty()
        if ((path.isNotEmpty() && path != "/") || uri.rawQuery != null || uri.rawFragment != null) {
            return ServerAddressResult.Invalid("只填写服务器地址，不要包含路径")
        }
        if (uri.port == 0 || uri.port > 65535) return ServerAddressResult.Invalid("端口无效")
        if (!explicitScheme && host in httpHosts) scheme = "http"
        if (scheme == "http" && host !in httpHosts) {
            return ServerAddressResult.Invalid("NBase 只允许本机回环地址使用 HTTP，其他地址请使用 https://")
        }
        return ServerAddressResult.Valid(build(scheme, host, uri.port))
    }

    /** Returns the origin of an http(s) or blob: URL in the same form as [parse], or null for anything else. */
    fun originOf(url: String): String? {
        if (url.regionMatches(0, "blob:", 0, 5, ignoreCase = true)) return originOf(url.substring(5))
        val match = originPrefix.find(url) ?: return null
        val scheme = match.groupValues[1].lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") return null
        val uri = parseUri("$scheme://${match.groupValues[2]}") ?: return null
        if (uri.rawUserInfo != null) return null
        val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
        return build(scheme, host, uri.port)
    }

    private fun build(scheme: String, host: String, port: Int): String {
        val defaultPort = if (scheme == "https") 443 else 80
        return if (port == -1 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }

    private fun parseUri(value: String): URI? = try {
        URI(value)
    } catch (_: URISyntaxException) {
        null
    }
}
