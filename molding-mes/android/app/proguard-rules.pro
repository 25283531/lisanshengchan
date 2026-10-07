# 混淆规则（release 构建默认未开启混淆，如需开启请同步补充以下保留项）
-keep class com.molding.mes.data.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
-dontwarn okhttp3.**
-dontwarn retrofit2.**
