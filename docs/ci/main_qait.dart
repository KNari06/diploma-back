// lib/main_qait.dart
//
// A QAIT-only entrypoint. Your production `lib/main.dart` is NOT modified —
// this file wraps it, turning on the Flutter driver extension that QAIT uses
// to drive the app, and then hands straight over to your real `main()`.
//
// Nothing here ships in your release build: you only ever build with
// `--target=lib/main_qait.dart` in the QAIT pipeline job.

import 'package:flutter_driver/driver_extension.dart';
import 'main.dart' as app;

void main() {
  enableFlutterDriverExtension();
  app.main();
}
