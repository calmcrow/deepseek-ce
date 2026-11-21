package com.linyan.deepseek

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import java.io.OutputStream

/**
 * 把网页导出的文件（聊天记录 ZIP）写进系统「下载」目录，或用户自己选的目录。
 *
 * 安卓 WebView 不支持 blob: 下载，所以网页通过 JS 接口把内容分块传过来，
 * 这里用 MediaStore 落盘，出现在的「文件 - 下载」里，不需要存储权限。
 * 用户在网页里选了别的目录（SAF 授权的树 URI）时，改走 DocumentsContract 写到那里面。
 */
class DownloadWriter(private val context: Context) {

    private var uri: Uri? = null
    private var stream: OutputStream? = null
    /** 当前这个文件是不是写在用户选定的目录里（那边不需要 IS_PENDING） */
    private var pendingInTree = false
    /** 用户选定的保存目录（SAF 树 URI）；为空表示写系统「下载」 */
    private var treeUri: Uri? = null

    fun setTreeUri(tree: Uri?) {
        treeUri = tree
    }

    /** 开始一个新文件；同名文件系统会自动加序号 */
    fun begin(name: String): Boolean {
        closeStream()
        val safeName = name.ifBlank { "deepseek-export.zip" }
        val target = treeUri
        return if (target == null) {
            beginInDownloads(safeName)
        } else {
            beginInTree(target, safeName) || beginInDownloads(safeName)
        }
    }

    /** 直接写系统「下载」目录（原来的行为） */
    private fun beginInDownloads(safeName: String): Boolean {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName)
            put(MediaStore.Downloads.MIME_TYPE, mimeTypeOf(safeName))
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val target = try {
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } catch (error: Exception) {
            null
        } ?: return false
        val output = try {
            resolver.openOutputStream(target)
        } catch (error: Exception) {
            null
        }
        if (output == null) {
            resolver.delete(target, null, null)
            return false
        }
        uri = target
        stream = output
        return true
    }

    /** 写用户选定的目录：在该目录下新建文档 */
    private fun beginInTree(tree: Uri, safeName: String): Boolean {
        val resolver = context.contentResolver
        return try {
            val parent = DocumentsContract.getTreeDocumentId(tree)
            val newDocument = DocumentsContract.createDocument(
                resolver,
                DocumentsContract.buildDocumentUriUsingTree(tree, parent),
                mimeTypeOf(safeName),
                safeName
            ) ?: return false
            val output = resolver.openOutputStream(newDocument) ?: return false
            uri = newDocument
            stream = output
            pendingInTree = true
            true
        } catch (error: Exception) {
            false
        }
    }

    /** 追加一块 base64 内容 */
    fun append(base64: String): Boolean {
        val output = stream ?: return false
        return try {
            output.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (error: Exception) {
            false
        }
    }

    /** 结束写入并让文件在下载目录可见 */
    fun end(): Boolean {
        val output = stream
        val target = uri
        val inTree = pendingInTree
        stream = null
        uri = null
        pendingInTree = false
        if (output == null || target == null) {
            return false
        }
        return try {
            output.flush()
            output.close()
            // 用户目录里的文档没有 IS_PENDING 概念，写完即可见
            if (!inTree) {
                val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                context.contentResolver.update(target, values, null, null)
            }
            true
        } catch (error: Exception) {
            false
        }
    }

    /** 中途失败时丢弃半成品 */
    fun abort() {
        val target = uri
        closeStream()
        if (target != null) {
            try {
                context.contentResolver.delete(target, null, null)
            } catch (error: Exception) {
                // 删不掉就留着，不影响使用
            }
        }
    }

    private fun closeStream() {
        try {
            stream?.close()
        } catch (error: Exception) {
            // 关流失败无需处理
        }
        stream = null
        uri = null
        pendingInTree = false
    }

    private fun mimeTypeOf(name: String): String = when {
        name.endsWith(".zip", ignoreCase = true) -> "application/zip"
        name.endsWith(".json", ignoreCase = true) -> "application/json"
        name.endsWith(".txt", ignoreCase = true) -> "text/plain"
        else -> "application/octet-stream"
    }
}
