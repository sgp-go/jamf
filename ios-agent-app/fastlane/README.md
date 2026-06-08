fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios match_dev

```sh
[bundle exec] fastlane ios match_dev
```

同步 Development 證書和 Provisioning Profiles

### ios match_adhoc

```sh
[bundle exec] fastlane ios match_adhoc
```

同步 Ad Hoc 證書和 Provisioning Profiles

### ios match_appstore

```sh
[bundle exec] fastlane ios match_appstore
```

同步 App Store 證書和 Provisioning Profiles

### ios match_init

```sh
[bundle exec] fastlane ios match_init
```

首次初始化：生成並上傳所有證書（僅需執行一次）

### ios generate

```sh
[bundle exec] fastlane ios generate
```

使用 Tuist 生成 Xcode 專案

### ios build_dev

```sh
[bundle exec] fastlane ios build_dev
```

構建 Development 版本

### ios build

```sh
[bundle exec] fastlane ios build
```

構建 Ad Hoc 版本（用於 Jamf 分發）

### ios distribute

```sh
[bundle exec] fastlane ios distribute
```

構建並匯出 IPA，準備上傳到 Jamf Pro

### ios beta

```sh
[bundle exec] fastlane ios beta
```

上傳到 TestFlight

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
