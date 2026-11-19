package com.deepseek.chatdemo;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 原生外壳：用 WebView 承载 chat-demo 的静态站点。
 *
 * 站点通过 WebViewAssetLoader 以 https://appassets.androidplatform.net/assets/www/
 * 的形式提供，因此页面处于安全上下文（secure context），localStorage、IndexedDB、
 * getUserMedia（语音输入）等能力都能正常工作。
 */
public class MainActivity extends Activity {

    private static final String TAG = "ChatDemo";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
            "https://" + APP_HOST + "/assets/www/index.html";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_AUDIO_PERMISSION = 1002;

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingPermissionRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setFitsSystemWindows(true);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        configureWebView();
        webView.loadUrl(START_URL);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " ChatDemoAndroid/" + BuildConfig.VERSION_NAME);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setBackgroundColor(0xFFFFFFFF);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectBlobDownloadHook(view);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(buildFileChooserIntent(params), REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    toast("没有可用的文件选择器");
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    List<String> wanted = new ArrayList<>();
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                            wanted.add(res);
                        }
                    }
                    if (wanted.isEmpty()) {
                        request.deny();
                        return;
                    }
                    if (hasAudioPermission()) {
                        request.grant(wanted.toArray(new String[0]));
                    } else {
                        pendingPermissionRequest = request;
                        requestPermissions(
                                new String[]{Manifest.permission.RECORD_AUDIO},
                                REQ_AUDIO_PERMISSION);
                    }
                });
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                // window.open / target=_blank：交给系统浏览器打开
                WebView proxy = new WebView(MainActivity.this);
                proxy.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        openExternal(request.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(proxy);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                Log.d(TAG, msg.message() + " @" + msg.sourceId() + ":" + msg.lineNumber());
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url.startsWith("data:")) {
                    saveDataUrl(url);
                } else if (url.startsWith("blob:")) {
                    toast("正在导出，请稍候…");
                } else {
                    enqueueDownload(url, userAgent, contentDisposition, mimeType);
                }
            }
        });
    }

    private Intent buildFileChooserIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] accept = params.getAcceptTypes();
        if (accept != null) {
            List<String> mimes = new ArrayList<>();
            for (String a : accept) {
                if (a == null) continue;
                for (String part : a.split(",")) {
                    String t = part.trim();
                    if (t.isEmpty()) continue;
                    if (t.startsWith(".")) {
                        // 扩展名形式的 accept，交给 */* 处理
                        continue;
                    }
                    mimes.add(t);
                }
            }
            if (!mimes.isEmpty()) {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            }
        }
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        return Intent.createChooser(intent, "选择文件");
    }

    private boolean handleUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if ("https".equals(scheme) && APP_HOST.equals(uri.getHost())) {
            return false; // 站内资源，交给 WebView
        }
        if ("http".equals(scheme) || "https".equals(scheme)
                || "mailto".equals(scheme) || "tel".equals(scheme)) {
            openExternal(uri);
            return true;
        }
        return true;
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            toast("没有可以打开该链接的应用");
        }
    }

    private void enqueueDownload(String url, String userAgent, String contentDisposition,
                                 String mimeType) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            req.addRequestHeader("User-Agent", userAgent);
            req.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, guessFileName(url, contentDisposition, mimeType));
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(req);
                toast("已开始下载");
            }
        } catch (Exception e) {
            Log.w(TAG, "download failed", e);
            openExternal(Uri.parse(url));
        }
    }

    private void saveDataUrl(String url) {
        try {
            int comma = url.indexOf(',');
            if (comma < 0) return;
            String meta = url.substring(5, comma);
            String payload = url.substring(comma + 1);
            boolean base64 = meta.endsWith(";base64");
            String mime = meta.split(";")[0];
            if (mime.isEmpty()) mime = "application/octet-stream";
            byte[] bytes = base64
                    ? Base64.decode(payload, Base64.DEFAULT)
                    : Uri.decode(payload).getBytes("UTF-8");
            writeToDownloads("chat-demo-" + System.currentTimeMillis() + guessExtension(mime), mime, bytes);
        } catch (Exception e) {
            Log.w(TAG, "save data url failed", e);
            toast("保存失败");
        }
    }

    private void writeToDownloads(String name, String mime, byte[] bytes) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("insert failed");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) throw new IllegalStateException("open failed");
                    os.write(bytes);
                }
                toast("已保存到下载目录：" + name);
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = getFilesDir();
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, name);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(bytes);
                }
                toast("已保存：" + out.getAbsolutePath());
            }
        } catch (Exception e) {
            Log.w(TAG, "write failed", e);
            toast("保存失败：" + e.getMessage());
        }
    }

    private static String guessExtension(String mime) {
        if (mime == null) return "bin";
        switch (mime) {
            case "application/zip": return "zip";
            case "image/png": return "png";
            case "image/jpeg": return "jpg";
            case "application/json": return "json";
            case "text/plain": return "txt";
            default: return "bin";
        }
    }

    private static String guessFileName(String url, String contentDisposition, String mime) {
        if (contentDisposition != null) {
            String[] parts = contentDisposition.split(";");
            for (String p : parts) {
                String t = p.trim();
                if (t.startsWith("filename=")) {
                    String name = t.substring("filename=".length()).trim().replace("\"", "");
                    if (!name.isEmpty()) return name;
                }
            }
        }
        String last = Uri.parse(url).getLastPathSegment();
        if (last != null && !last.isEmpty()) return last;
        return "chat-demo-" + System.currentTimeMillis() + "." + guessExtension(mime);
    }

    /**
     * 页面里的“导出历史”用的是 blob: URL + <a download>，WebView 不会触发 DownloadListener，
     * 这里拦截点击，把 blob 转成 base64 交给原生侧写入下载目录。
     */
    private void injectBlobDownloadHook(WebView view) {
        String js = "(function(){"
                + "if(window.__chatDemoBlobHook)return;window.__chatDemoBlobHook=true;"
                + "document.addEventListener('click',function(e){"
                + "var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;"
                + "if(!a)return;var href=a.getAttribute('href')||'';"
                + "if(href.indexOf('blob:')!==0)return;"
                + "e.preventDefault();e.stopPropagation();"
                + "fetch(href).then(function(r){return r.blob();}).then(function(b){"
                + "var fr=new FileReader();fr.onload=function(){"
                + "var s=String(fr.result);var i=s.indexOf(',');"
                + "AndroidBridge.saveBase64(a.getAttribute('download')||'chat-demo.zip',"
                + "b.type||'application/octet-stream',s.substring(i+1));};"
                + "fr.readAsDataURL(b);}).catch(function(err){"
                + "AndroidBridge.toast('导出失败：'+err);});"
                + "},true);})();";
        view.evaluateJavascript(js, null);
    }

    private boolean hasAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_AUDIO_PERMISSION && pendingPermissionRequest != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermissionRequest.grant(
                        new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingPermissionRequest.deny();
                toast("需要麦克风权限才能使用语音输入");
            }
            pendingPermissionRequest = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE_CHOOSER) return;
        if (filePathCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 单个响应最多读取的字节数，避免异常站点把内存吃满 */
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

    private void performHttpRequest(String id, String method, String url, String headersJson,
                                    String body) {
        int status = 0;
        String text = "";
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
            conn.setRequestProperty("Accept-Encoding", "gzip");
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    String value = headers.optString(key, "");
                    if (!value.isEmpty()) {
                        conn.setRequestProperty(key, value);
                    }
                }
            }
            if (body != null && !body.isEmpty()
                    && !"GET".equalsIgnoreCase(conn.getRequestMethod())
                    && !"HEAD".equalsIgnoreCase(conn.getRequestMethod())) {
                conn.setDoOutput(true);
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                }
            }
            status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (stream != null && "gzip".equalsIgnoreCase(conn.getContentEncoding())) {
                stream = new GZIPInputStream(stream);
            }
            text = readLimited(stream, conn.getContentType());
            conn.disconnect();
        } catch (Exception e) {
            Log.w(TAG, "httpRequest failed: " + url, e);
            text = e.getMessage() == null ? e.toString() : e.getMessage();
        }
        final int code = status;
        final String payload = text;
        if (webView == null) {
            return;
        }
        final String script = "window.__chatDemoNativeHttp&&window.__chatDemoNativeHttp("
                + JSONObject.quote(id) + "," + code + "," + JSONObject.quote(payload) + ")";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private static String readLimited(InputStream stream, String contentType) throws IOException {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) > 0) {
            out.write(buffer, 0, read);
            if (out.size() >= MAX_RESPONSE_BYTES) {
                break;
            }
        }
        stream.close();
        Charset charset = StandardCharsets.UTF_8;
        if (contentType != null) {
            Matcher matcher = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE)
                    .matcher(contentType);
            if (matcher.find()) {
                try {
                    charset = Charset.forName(matcher.group(1));
                } catch (Exception ignored) {
                    // 未知字符集按 UTF-8 处理
                }
            }
        }
        return out.toString(charset.name());
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    /** 暴露给页面的原生能力 */
    public class Bridge {
        @JavascriptInterface
        public void saveBase64(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeName = (name == null || name.trim().isEmpty())
                        ? "chat-demo-" + System.currentTimeMillis() + ".zip" : name.trim();
                writeToDownloads(safeName, mime == null ? "application/octet-stream" : mime, bytes);
            } catch (Exception e) {
                Log.w(TAG, "saveBase64 failed", e);
                toast("导出失败：" + e.getMessage());
            }
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.toast(msg);
        }

        /**
         * 供页面发起的通用 HTTP 请求（联网搜索用）。
         * 浏览器里的 fetch 会被 CORS 拦住，而搜索引擎普遍不放行跨域，
         * 这里用原生连接代发，结果以 JSON 字符串回调 window.__chatDemoNativeHttp。
         */
        @JavascriptInterface
        public void httpRequest(String id, String method, String url, String headersJson, String body) {
            new Thread(() -> performHttpRequest(id, method, url, headersJson, body)).start();
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}
