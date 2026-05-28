using Microsoft.Extensions.Logging;

namespace CoGrowMDMAgent.Config;

/// <summary>
/// Mutable holder for <see cref="AgentConfig"/> that supports hot-reload from
/// Registry (or any loader) without restarting the service.
///
/// <para>Why not just inject <see cref="AgentConfig"/> as a singleton?</para>
/// The current AgentConfig is an immutable snapshot captured at startup; if
/// MDM rotates the agent_token or moves api_endpoint via Registry CSP push,
/// the running service would keep using stale values until restart. This
/// provider lets callers grab <see cref="Current"/> on every request (cheap
/// — just a locked field read) and exposes <see cref="TryReload"/> so the
/// Worker can re-read Registry at cycle boundaries.
///
/// <para>Loader is injected as a <see cref="Func{AgentConfig}"/> so tests can
/// pass any source without touching Registry; production wires
/// <c>() => sp.GetRequiredService&lt;RegistryConfig&gt;().Load()</c>.</para>
/// </summary>
public sealed class AgentConfigProvider
{
    private readonly Func<AgentConfig> _loader;
    private readonly ILogger<AgentConfigProvider> _logger;
    private readonly object _lock = new();
    private AgentConfig _current;

    /// <summary>
    /// Raised after a successful <see cref="TryReload"/> that detected a
    /// change. Handlers run on the calling thread (the Worker thread in
    /// production); keep them quick — heavy work belongs in the next cycle.
    /// </summary>
    public event EventHandler<AgentConfig>? ConfigChanged;

    public AgentConfigProvider(
        Func<AgentConfig> loader,
        ILogger<AgentConfigProvider> logger)
    {
        _loader = loader;
        _logger = logger;
        _current = loader();
    }

    public AgentConfig Current
    {
        get
        {
            lock (_lock) return _current;
        }
    }

    /// <summary>
    /// Re-invoke the loader. If the new config differs from the previous one,
    /// swap it in and fire <see cref="ConfigChanged"/>. Loader failures are
    /// logged but never throw (keep old config — better than crashing the
    /// service on a transient Registry hiccup).
    /// </summary>
    /// <returns><c>true</c> iff the config actually changed.</returns>
    public bool TryReload()
    {
        AgentConfig fresh;
        try
        {
            fresh = _loader();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Config reload failed; keeping previous config");
            return false;
        }

        AgentConfig previous;
        bool changed;
        lock (_lock)
        {
            previous = _current;
            changed = !ConfigEqual(previous, fresh);
            if (changed) _current = fresh;
        }

        if (changed)
        {
            _logger.LogInformation(
                "Config reloaded — endpoint: {OldEndpoint} → {NewEndpoint}, " +
                "token: {OldToken} → {NewToken}, tenant: {OldTenant} → {NewTenant}",
                previous.ApiEndpoint, fresh.ApiEndpoint,
                Mask(previous.AgentToken), Mask(fresh.AgentToken),
                previous.TenantId, fresh.TenantId);
            ConfigChanged?.Invoke(this, fresh);
        }
        return changed;
    }

    private static bool ConfigEqual(AgentConfig a, AgentConfig b) =>
        a.DeviceId == b.DeviceId &&
        a.AgentToken == b.AgentToken &&
        a.ApiEndpoint == b.ApiEndpoint &&
        a.TenantId == b.TenantId;

    /// <summary>Mask secrets in logs: keep first/last 4 chars, hide the rest.</summary>
    internal static string Mask(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "(empty)";
        if (s.Length <= 8) return "***";
        return $"{s[..4]}...{s[^4..]}";
    }
}
