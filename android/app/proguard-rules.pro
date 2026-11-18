# WebView JS 桥接方法不能被混淆
-keepclassmembers class com.deepseek.chatdemo.MainActivity$Bridge {
    public *;
}
-keepattributes JavascriptInterface
