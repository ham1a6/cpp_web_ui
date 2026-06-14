using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MapServer;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = null; });
builder.Logging.SetMinimumLevel(LogLevel.Information);

var cfg = builder.Configuration.GetSection("Map");

int    port          = cfg.GetValue("Port",          9000);
string title         = cfg.GetValue("Title",         "MapServer")!;
double centerLat     = cfg.GetValue("CenterLat",     35.690);
double centerLon     = cfg.GetValue("CenterLon",     139.700);
int    initialZoom   = cfg.GetValue("InitialZoom",   14);
int    maxZoom       = cfg.GetValue("MaxZoom",       -1);
int    maxNativeZoom = cfg.GetValue("MaxNativeZoom", -1);
string overlayUrl    = cfg.GetValue("OverlayUrl",    "")!;
string overlayAttr   = cfg.GetValue("OverlayAttribution", "")!;
double overlayOpac   = cfg.GetValue("OverlayOpacity", 0.75);
string shmName       = cfg.GetValue("ShmName",       "/map_positions")!;

// ---------------------------------------------------------------------------
// Web root detection (mirrors MapServer.cpp detectWebRoot)
// ---------------------------------------------------------------------------

static string? DetectWebRoot()
{
    var env = Environment.GetEnvironmentVariable("CPP_WEB_UI_WEB_ROOT");
    if (!string.IsNullOrEmpty(env) && File.Exists(Path.Combine(env, "index.html")))
        return env;

    // Search relative to the executable (cross-platform: AppContext.BaseDirectory)
    string bin = AppContext.BaseDirectory;
    foreach (var rel in new[] { "../web", "../../web", "web" })
    {
        string candidate = Path.GetFullPath(Path.Combine(bin, rel));
        if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
    }
    return null;
}

static int DetectMaxNativeZoom(string tilesDir)
{
    if (!Directory.Exists(tilesDir)) return -1;
    int maxZ = -1;
    for (int z = 0; z <= 20; z++)
    {
        string zdir = Path.Combine(tilesDir, z.ToString());
        if (!Directory.Exists(zdir)) continue;
        bool found = false;
        foreach (var xdir in Directory.EnumerateDirectories(zdir))
        {
            if (Directory.EnumerateFiles(xdir, "*.png").Any())
            { found = true; break; }
        }
        if (found) maxZ = z;
    }
    return maxZ;
}

string? webRoot = DetectWebRoot();
if (webRoot is null)
    Console.Error.WriteLine(
        "MapServer: web_root not found — set CPP_WEB_UI_WEB_ROOT or run from repo root");
else
    Console.Error.WriteLine($"MapServer: web_root = {webRoot}");

if (maxNativeZoom < 0 || maxZoom < 0)
{
    int detected = webRoot is not null
        ? DetectMaxNativeZoom(Path.Combine(webRoot, "tiles"))
        : -1;
    if (detected < 0) detected = 10;
    if (maxNativeZoom < 0) maxNativeZoom = detected;
    if (maxZoom       < 0) maxZoom       = maxNativeZoom;
    Console.Error.WriteLine(
        $"MapServer: tiles detected max_native_zoom={maxNativeZoom}  max_zoom={maxZoom}");
}

// ---------------------------------------------------------------------------
// Viewshed engine
// ---------------------------------------------------------------------------

ViewshedComputer? vshedComputer = null;
if (webRoot is not null)
{
    string terrainDir = Path.Combine(webRoot, "terrain-rgb");
    if (Directory.Exists(terrainDir))
    {
        vshedComputer = new ViewshedComputer(terrainDir);
        Console.Error.WriteLine($"MapServer: viewshed engine ready ({terrainDir})");
    }
    else
    {
        Console.Error.WriteLine(
            "MapServer: terrain-rgb not found — viewshed disabled " +
            "(run scripts/generate_terrain_rgb.py)");
    }
}

// ---------------------------------------------------------------------------
// Overlay tile proxy
// ---------------------------------------------------------------------------

// If overlay_url is an external http/https URL, proxy through this server
// so the browser only needs localhost access.
string? proxyUpstreamScheme = null;
string? proxyUpstreamHost   = null;
string? proxyPathTemplate   = null;

if (!string.IsNullOrEmpty(overlayUrl) &&
    (overlayUrl.StartsWith("http://") || overlayUrl.StartsWith("https://")))
{
    var uri = new Uri(overlayUrl);
    proxyUpstreamScheme = uri.Scheme;
    proxyUpstreamHost   = uri.Host + (uri.IsDefaultPort ? "" : $":{uri.Port}");
    proxyPathTemplate   = uri.PathAndQuery;
    overlayUrl          = "/overlay-tiles/{z}/{x}/{y}";
    Console.Error.WriteLine($"MapServer: overlay proxy enabled ({proxyUpstreamHost})");
}

// In-memory tile cache (max 2000 entries, clear on overflow)
var overlayCache     = new Dictionary<string, byte[]>();
var overlayCacheLock = new object();
const int OverlayCacheMax = 2000;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

var symbols = new SymbolTable();
builder.Services.AddSingleton(symbols);
builder.Services.AddSingleton<ILogger<ShmPoller>>(sp =>
    sp.GetRequiredService<ILoggerFactory>().CreateLogger<ShmPoller>());

if (!string.IsNullOrEmpty(shmName))
{
    builder.Services.AddSingleton(sp =>
        new ShmPoller(shmName, symbols, sp.GetRequiredService<ILogger<ShmPoller>>()));
    builder.Services.AddHostedService(sp => sp.GetRequiredService<ShmPoller>());
}

builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

var app = builder.Build();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/config
app.MapGet("/api/config", () =>
{
    var config = new JsonObject
    {
        ["center"]           = new JsonArray(centerLat, centerLon),
        ["zoom"]             = initialZoom,
        ["tile_url"]         = "/tiles/{z}/{x}/{y}.png",
        ["attribution"]      = "",
        ["min_zoom"]         = 0,
        ["max_zoom"]         = maxZoom,
        ["max_native_zoom"]  = maxNativeZoom,
        ["overlay_url"]      = overlayUrl,
        ["overlay_attribution"] = overlayAttr,
        ["overlay_opacity"]  = overlayOpac,
        ["title"]            = title,
    };
    return Results.Content(config.ToJsonString(), "application/json",
        Encoding.UTF8, 200);
}).WithMetadata(new NoCache());

// GET /api/positions
app.MapGet("/api/positions", (SymbolTable sym) =>
    Results.Content(sym.Snapshot(), "application/json"));

// GET /events  — Server-Sent Events
app.MapGet("/events", async (HttpContext ctx, SymbolTable sym) =>
{
    ctx.Response.ContentType = "text/event-stream";
    ctx.Response.Headers["Cache-Control"]               = "no-cache";
    ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
    ctx.Response.Headers["X-Accel-Buffering"]           = "no";

    var reader = sym.Subscribe();
    try
    {
        // Send current snapshot immediately on connect
        string initial = $"data: {sym.Snapshot()}\n\n";
        await ctx.Response.WriteAsync(initial, ctx.RequestAborted);
        await ctx.Response.Body.FlushAsync(ctx.RequestAborted);

        while (!ctx.RequestAborted.IsCancellationRequested)
        {
            string msg;
            try { msg = await reader.ReadAsync(ctx.RequestAborted); }
            catch (OperationCanceledException) { break; }

            await ctx.Response.WriteAsync($"data: {msg}\n\n", ctx.RequestAborted);
            await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
        }
    }
    catch (OperationCanceledException) { }
    finally { sym.Unsubscribe(reader); }
});

// POST /api/symbols
app.MapPost("/api/symbols", async (HttpContext ctx, SymbolTable sym) =>
{
    using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
    var root = doc.RootElement;

    if (!root.TryGetProperty("label", out var labelEl))
        return Results.Content("""{"error":"label required"}""", "application/json",
            Encoding.UTF8, 400);

    string label = labelEl.GetString() ?? "";
    if (label.Length == 0 || label.Length > 31)
        return Results.Content("""{"error":"label must be 1-31 chars"}""",
            "application/json", Encoding.UTF8, 400);

    double lat  = GetOrDefault(root, "lat",  0.0);
    double lon  = GetOrDefault(root, "lon",  0.0);
    string type = GetOrDefaultStr(root, "type", "unknown");

    sym.Set(label, lat, lon, type);
    return Results.Content("{}", "application/json");
});

// DELETE /api/symbols  — clear all
app.MapDelete("/api/symbols", (SymbolTable sym) =>
{
    sym.Clear();
    return Results.Content("{}", "application/json");
});

// DELETE /api/symbols/{label}  — remove one
app.MapDelete("/api/symbols/{label}", (string label, SymbolTable sym) =>
{
    sym.Remove(label);
    return Results.Content("{}", "application/json");
});

// POST /api/viewshed
app.MapPost("/api/viewshed", async (HttpContext ctx) =>
{
    if (vshedComputer is null)
        return Results.Content(
            """{"error":"terrain-rgb tiles not found; run generate_terrain_rgb.py first"}""",
            "application/json", Encoding.UTF8, 503);

    using var body = new StreamReader(ctx.Request.Body);
    string paramsJson = await body.ReadToEndAsync();

    try
    {
        using var doc  = JsonDocument.Parse(paramsJson);
        var root = doc.RootElement;
        foreach (var key in new[] {"lat","lon","height_agl","range_km",
                                    "az_min","az_max","el_min","el_max"})
        {
            if (!root.TryGetProperty(key, out _))
                return Results.Content(
                    JsonSerializer.Serialize(new { error = $"missing field: {key}" }),
                    "application/json", Encoding.UTF8, 400);
        }
    }
    catch
    {
        return Results.Content("""{"error":"invalid JSON"}""",
            "application/json", Encoding.UTF8, 400);
    }

    string result = vshedComputer.Run(paramsJson);
    ctx.Response.Headers["Cache-Control"] = "no-store";
    return Results.Content(result, "application/json");
});

// GET /overlay-tiles/{z}/{x}/{y}
if (proxyUpstreamHost is not null)
{
    var httpClient = new HttpClient();
    httpClient.Timeout = TimeSpan.FromSeconds(10);

    app.MapGet("/overlay-tiles/{z}/{x}/{y}", async (
        string z, string x, string y,
        HttpContext ctx) =>
    {
        string pathForUpstream = proxyPathTemplate!
            .Replace("{z}", z).Replace("{x}", x).Replace("{y}", y);

        // 1. Check disk (pre-downloaded or cached from a prior request)
        if (webRoot is not null)
        {
            foreach (var ext in new[] { ".png", ".jpg" })
            {
                string diskPath = Path.Combine(
                    webRoot, "overlay-tiles", z, x, y + ext);
                if (File.Exists(diskPath))
                    return ServeTileFromDisk(diskPath, ctx);
            }
        }

        // 2. Memory cache
        lock (overlayCacheLock)
        {
            if (overlayCache.TryGetValue(pathForUpstream, out var cached))
            {
                ctx.Response.Headers["Cache-Control"] = "public, max-age=300";
                string ct = pathForUpstream.Contains(".jp") ? "image/jpeg" : "image/png";
                return Results.Bytes(cached, ct);
            }
        }

        // 3. Fetch from upstream
        try
        {
            string url = $"{proxyUpstreamScheme}://{proxyUpstreamHost}{pathForUpstream}";
            var resp = await httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return Results.NotFound();

            byte[] data        = await resp.Content.ReadAsByteArrayAsync();
            string contentType = resp.Content.Headers.ContentType?.MediaType ?? "image/png";

            // 4. Persist to disk for offline reuse
            if (webRoot is not null)
            {
                string ext = contentType.Contains("jpeg") ? ".jpg" : ".png";
                string dir = Path.Combine(webRoot, "overlay-tiles", z, x);
                Directory.CreateDirectory(dir);
                await File.WriteAllBytesAsync(Path.Combine(dir, y + ext), data);
            }

            // 5. Store in memory cache
            lock (overlayCacheLock)
            {
                if (overlayCache.Count >= OverlayCacheMax) overlayCache.Clear();
                overlayCache[pathForUpstream] = data;
            }

            ctx.Response.Headers["Cache-Control"] = "public, max-age=300";
            return Results.Bytes(data, contentType);
        }
        catch
        {
            return Results.NotFound();
        }
    });
}

// GET /* — static file serving (tiles: cache 5 min + ETag, others: no-store)
app.MapGet("/{**path}", (string? path, HttpContext ctx) =>
{
    if (webRoot is null)
        return Results.Content(
            "web_root not configured; set CPP_WEB_UI_WEB_ROOT",
            "text/plain", Encoding.UTF8, 503);

    string relPath = string.IsNullOrEmpty(path) ? "index.html" : path;
    string absPath = Path.GetFullPath(Path.Combine(webRoot, relPath));

    // Prevent path traversal outside webRoot
    if (!absPath.StartsWith(webRoot + Path.DirectorySeparatorChar) &&
        absPath != webRoot)
        return Results.NotFound();

    if (!File.Exists(absPath)) return Results.NotFound();

    string ext         = Path.GetExtension(absPath).ToLowerInvariant();
    string contentType = MimeOf(ext);
    bool   isTile      = relPath.StartsWith("tiles/");

    if (isTile)
    {
        // Conditional GET with ETag
        var   fi   = new FileInfo(absPath);
        string etag = $"\"{fi.Length:x}-{fi.LastWriteTimeUtc.Ticks:x}\"";
        if (ctx.Request.Headers["If-None-Match"] == etag)
            return Results.StatusCode(304);
        ctx.Response.Headers["Cache-Control"] = "public, max-age=300, must-revalidate";
        ctx.Response.Headers["ETag"]          = etag;
    }
    else
    {
        ctx.Response.Headers["Cache-Control"] = "no-store";
    }

    return Results.File(absPath, contentType);
});

Console.Error.WriteLine($"MapServer: listening on http://0.0.0.0:{port}");
Console.WriteLine($"Open http://localhost:{port}");
app.Run();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static double GetOrDefault(JsonElement el, string key, double def) =>
    el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
        ? v.GetDouble() : def;

static string GetOrDefaultStr(JsonElement el, string key, string def) =>
    el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
        ? v.GetString() ?? def : def;

static IResult ServeTileFromDisk(string path, HttpContext ctx)
{
    var   fi   = new FileInfo(path);
    string etag = $"\"{fi.Length:x}-{fi.LastWriteTimeUtc.Ticks:x}\"";
    if (ctx.Request.Headers["If-None-Match"] == etag)
        return Results.StatusCode(304);
    ctx.Response.Headers["Cache-Control"] = "public, max-age=300, must-revalidate";
    ctx.Response.Headers["ETag"]          = etag;
    string mime = Path.GetExtension(path).ToLowerInvariant() == ".jpg"
                  ? "image/jpeg" : "image/png";
    return Results.File(path, mime);
}

static string MimeOf(string ext) => ext switch
{
    ".html" => "text/html; charset=utf-8",
    ".css"  => "text/css",
    ".js"   => "application/javascript",
    ".png"  => "image/png",
    ".jpg" or ".jpeg" => "image/jpeg",
    ".pbf"  => "application/x-protobuf",
    _       => "application/octet-stream",
};

// Marker attribute for no-cache (not used functionally, just for clarity)
internal sealed class NoCache : Attribute { }
