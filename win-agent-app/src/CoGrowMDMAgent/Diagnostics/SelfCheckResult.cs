namespace CoGrowMDMAgent.Diagnostics;

/// <summary>
/// 啟動自檢結果。<see cref="Ok"/> 為 true 表示 DI graph 與 config 皆健全；
/// 否則 <see cref="Failures"/> 列出每條具體問題（供寫入 Event Log 診斷）。
/// </summary>
public sealed record SelfCheckResult(bool Ok, IReadOnlyList<string> Failures)
{
    public static SelfCheckResult Success { get; } =
        new(true, Array.Empty<string>());

    public static SelfCheckResult Failed(IReadOnlyList<string> failures) =>
        new(false, failures);
}
