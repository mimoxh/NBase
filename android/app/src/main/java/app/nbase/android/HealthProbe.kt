package app.nbase.android

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import org.json.JSONException
import org.json.JSONObject

object HealthProbe {
    private const val TIMEOUT_MS = 8_000
    private const val MAX_BODY = 16 * 1024
    private val persistenceModes = setOf("not-configured", "accounts-only", "page-api")

    /** Returns null when [origin] answers the NBase health contract, otherwise a message for the user. */
    fun check(origin: String): String? {
        val connection = try {
            URL("$origin/api/health").openConnection() as HttpURLConnection
        } catch (_: IOException) {
            return "地址无效"
        }
        return try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) return "服务器返回 HTTP $code，不是可用的 NBase 服务"
            val body = connection.inputStream.use { readLimited(it) } ?: return "这个地址不是 NBase 服务器"
            if (matchesContract(body)) null else "这个地址不是 NBase 服务器"
        } catch (e: SSLException) {
            if (isCertificateFailure(e)) {
                "证书校验失败。请使用受信任的证书，自签名证书须先把签发它的 CA 安装到手机"
            } else {
                "HTTPS 握手失败，请确认这个端口提供的是 HTTPS 服务"
            }
        } catch (_: UnknownHostException) {
            "找不到这个主机名"
        } catch (_: SocketTimeoutException) {
            "连接超时，请确认手机能访问这台服务器"
        } catch (e: IOException) {
            "无法连接：${e.message ?: e.javaClass.simpleName}"
        } finally {
            connection.disconnect()
        }
    }

    private fun isCertificateFailure(error: Throwable): Boolean =
        generateSequence(error) { it.cause }.take(8).any {
            it is CertificateException || it is CertPathValidatorException || it is SSLPeerUnverifiedException
        }

    /** Same checks as `isHealthResponse` in packages/contracts. */
    private fun matchesContract(body: String): Boolean = try {
        val json = JSONObject(body)
        json.optString("service") == "nbase" && json.optString("status") == "ok"
            && json.optString("stage") == "foundation" && json.optString("persistence") in persistenceModes
    } catch (_: JSONException) {
        false
    }

    private fun readLimited(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > MAX_BODY) return null
        }
        return out.toString(Charsets.UTF_8.name())
    }
}
