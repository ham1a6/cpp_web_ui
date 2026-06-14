using System.Collections.Concurrent;
using System.Text.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace MapServer;

/// <summary>
/// C# port of src/ViewshedComputer.cpp.
/// Computes 3-D radar coverage envelopes and vertical cross-sections from
/// terrain-RGB tiles (Terrarium encoding).  Same JSON I/O contract as the
/// C++ implementation and the original Python script.
/// </summary>
public sealed class ViewshedComputer
{
    private const double REarth  = 6_371_000.0;
    private const double REff    = REarth * 4.0 / 3.0; // atmospheric refraction
    private const double Deg2Rad = Math.PI / 180.0;

    private readonly string _terrainDir;
    private readonly int    _zoom;

    // Tile cache: zoom*1e9 + x*1e5 + y → 256×256 float elevation array (null = missing)
    private readonly ConcurrentDictionary<ulong, float[]?> _tileCache = new();

    public ViewshedComputer(string terrainDir, int zoom = 12)
    {
        _terrainDir = terrainDir;
        _zoom       = zoom;
    }

    // -------------------------------------------------------------------------
    // Entry point
    // -------------------------------------------------------------------------

    public string Run(string paramsJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(paramsJson);
            var p = doc.RootElement;
            if (p.TryGetProperty("section_only", out var so) && so.GetBoolean())
                return RunSection(p);
            return Compute(p);
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { error = ex.Message });
        }
    }

    // -------------------------------------------------------------------------
    // Tile loading (Terrarium PNG → float elevation array)
    // -------------------------------------------------------------------------

    private static ulong TileKey(int z, int x, int y) =>
        (ulong)z * 1_000_000_000UL + (ulong)x * 100_000UL + (ulong)(uint)y;

    private float[]? LoadTile(int z, int x, int y)
    {
        ulong key = TileKey(z, x, y);
        if (_tileCache.TryGetValue(key, out var cached)) return cached;

        float[]? tile = null;
        string path = Path.Combine(_terrainDir,
            z.ToString(), x.ToString(), $"{y}.png");

        if (File.Exists(path))
        {
            try
            {
                using var img = Image.Load<Rgb24>(path);
                if (img.Width == 256 && img.Height == 256)
                {
                    tile = new float[256 * 256];
                    img.ProcessPixelRows(accessor =>
                    {
                        for (int py = 0; py < 256; py++)
                        {
                            var row = accessor.GetRowSpan(py);
                            for (int px = 0; px < 256; px++)
                            {
                                ref var pix = ref row[px];
                                tile[py * 256 + px] =
                                    pix.R * 256f + pix.G + pix.B / 256f - 32768f;
                            }
                        }
                    });
                }
            }
            catch { /* missing or corrupt tile → null */ }
        }

        // Simple eviction: clear half when cache grows large
        if (_tileCache.Count > 800)
        {
            int toRemove = 400;
            foreach (var k in _tileCache.Keys)
            {
                if (toRemove-- <= 0) break;
                _tileCache.TryRemove(k, out _);
            }
        }
        _tileCache[key] = tile;
        return tile;
    }

    // -------------------------------------------------------------------------
    // Coordinate math
    // -------------------------------------------------------------------------

    private static (double fx, double fy) LatLonToTileFloat(double lat, double lon, int z)
    {
        double n  = 1 << z;
        double fx = (lon + 180.0) / 360.0 * n;
        double lr = lat * Deg2Rad;
        double fy = (1.0 - Math.Log(Math.Tan(lr) + 1.0 / Math.Cos(lr)) / Math.PI)
                    / 2.0 * n;
        return (fx, fy);
    }

    private float GetElevationAtZoom(double lat, double lon, int z)
    {
        var (fx, fy) = LatLonToTileFloat(lat, lon, z);
        int n  = 1 << z;
        int tx = Math.Clamp((int)fx, 0, n - 1);
        int ty = Math.Clamp((int)fy, 0, n - 1);

        var tile = LoadTile(z, tx, ty);
        if (tile is null)
            return z > 5 ? GetElevationAtZoom(lat, lon, z - 1) : 0f;

        int px = Math.Clamp((int)((fx - tx) * 256), 0, 255);
        int py = Math.Clamp((int)((fy - ty) * 256), 0, 255);
        return tile[py * 256 + px];
    }

    private float GetElevation(double lat, double lon) =>
        GetElevationAtZoom(lat, lon, _zoom);

    // -------------------------------------------------------------------------
    // Geodesy: great-circle destination point
    // -------------------------------------------------------------------------

    private static (double lat, double lon)
    Destination(double lat0, double lon0, double bearingDeg, double distM)
    {
        double lat = lat0 * Deg2Rad;
        double lon = lon0 * Deg2Rad;
        double brg = bearingDeg * Deg2Rad;
        double d   = distM / REarth;

        double sinLat = Math.Sin(lat), cosLat = Math.Cos(lat);
        double sinD   = Math.Sin(d),   cosD   = Math.Cos(d);

        double lat2 = Math.Asin(sinLat * cosD + cosLat * sinD * Math.Cos(brg));
        double lon2 = lon + Math.Atan2(Math.Sin(brg) * sinD * cosLat,
                                       cosD - sinLat * Math.Sin(lat2));
        return (lat2 / Deg2Rad, lon2 / Deg2Rad);
    }

    // -------------------------------------------------------------------------
    // Ray tracer
    // -------------------------------------------------------------------------

    private record RayResult(
        double Lat, double Lon, double AltAsl,
        bool TerrainHit, double RangeM);

    private RayResult TraceRay(
        double lat0, double lon0, double h0Asl,
        double azDeg, double elDeg, double maxRM, double stepM)
    {
        double el       = elDeg * Deg2Rad;
        double sinEl    = Math.Sin(el);
        double inv2Reff = 1.0 / (2.0 * REff);

        for (double r = stepM; r <= maxRM; r += stepM)
        {
            var (lat, lon) = Destination(lat0, lon0, azDeg, r);
            double hRay = h0Asl + r * sinEl - r * r * inv2Reff;
            double hTer = GetElevation(lat, lon);

            if (hRay <= hTer)
            {
                double rPrev = r - stepM;
                var (lp, lop) = Destination(lat0, lon0, azDeg, rPrev);
                double hRayP  = h0Asl + rPrev * sinEl - rPrev * rPrev * inv2Reff;
                double hTerP  = GetElevation(lp, lop);
                double denom  = (hRay - hRayP) - (hTer - hTerP);

                if (Math.Abs(denom) > 0.01)
                {
                    double t     = Math.Clamp((hTerP - hRayP) / denom, 0.0, 1.0);
                    double rHit  = rPrev + t * stepM;
                    var (lh, oh) = Destination(lat0, lon0, azDeg, rHit);
                    return new RayResult(lh, oh, GetElevation(lh, oh), true, rHit);
                }
                return new RayResult(lat, lon, hTer, true, r);
            }
        }

        var (latF, lonF) = Destination(lat0, lon0, azDeg, maxRM);
        double hRayF = h0Asl + maxRM * sinEl - maxRM * maxRM * inv2Reff;
        double hTerF = GetElevation(latF, lonF);
        return new RayResult(latF, lonF, Math.Max(hRayF, hTerF), false, maxRM);
    }

    // -------------------------------------------------------------------------
    // Vertical cross-section
    // -------------------------------------------------------------------------

    private object ComputeSection(
        double lat0, double lon0, double hAsl0,
        double azDeg, double elMaxDeg, double rangeKm, double rayStepM)
    {
        double elMaxRad = elMaxDeg * Deg2Rad;
        double maxRM    = rangeKm * 1000.0;
        double inv2Reff = 1.0 / (2.0 * REff);

        var rangeList   = new List<double>();
        var terrainList = new List<double>();
        var minVisList  = new List<double>();
        var maxCovList  = new List<double>();

        double maxElHor = double.NegativeInfinity;

        for (double r = rayStepM; ; r += rayStepM)
        {
            r = Math.Min(r, maxRM);

            var (lat, lon) = Destination(lat0, lon0, azDeg, r);
            double ter = GetElevation(lat, lon);

            double elTer = Math.Atan2(ter - hAsl0 + r * r * inv2Reff, r);

            double minVis;
            if (elTer > maxElHor)
            {
                maxElHor = elTer;
                minVis   = ter;
            }
            else
            {
                double hHor = hAsl0 + r * Math.Sin(maxElHor) - r * r * inv2Reff;
                minVis = Math.Max(ter, hHor);
            }

            double maxCov = hAsl0 + r * Math.Sin(elMaxRad) - r * r * inv2Reff;

            rangeList  .Add(Math.Round(r    / 1000.0 * 1000.0) / 1000.0);
            terrainList.Add(Math.Round(ter    * 10.0) / 10.0);
            minVisList .Add(Math.Round(minVis * 10.0) / 10.0);
            maxCovList .Add(Math.Round(maxCov * 10.0) / 10.0);

            if (r >= maxRM) break;
        }

        return new
        {
            az_deg      = Math.Round(azDeg  * 10.0) / 10.0,
            radar_alt_m = Math.Round(hAsl0  * 10.0) / 10.0,
            range_km    = rangeList,
            terrain_m   = terrainList,
            min_vis_m   = minVisList,
            max_cov_m   = maxCovList,
        };
    }

    // -------------------------------------------------------------------------
    // Angle sequence generator (mirrors Python _make_angles / C++ makeAngles)
    // -------------------------------------------------------------------------

    private static IList<double> MakeAngles(double start, double stop, double step)
    {
        var v = new List<double>();
        for (double a = start; a < stop - step * 0.01; a += step)
            v.Add(a);
        v.Add(stop);
        return v;
    }

    // -------------------------------------------------------------------------
    // Full 3-D mesh computation
    // -------------------------------------------------------------------------

    private string Compute(JsonElement p)
    {
        double lat0     = p.GetProperty("lat").GetDouble();
        double lon0     = p.GetProperty("lon").GetDouble();
        double hAgl     = p.GetProperty("height_agl").GetDouble();
        double rangeKm  = p.GetProperty("range_km").GetDouble();
        double azMin    = p.GetProperty("az_min").GetDouble();
        double azMax    = p.GetProperty("az_max").GetDouble();
        double elMin    = p.GetProperty("el_min").GetDouble();
        double elMax    = p.GetProperty("el_max").GetDouble();
        double azStep   = GetOrDefault(p, "az_step",    2.0);
        double elStep   = GetOrDefault(p, "el_step",    1.0);
        double rayStep  = GetOrDefault(p, "ray_step_m", 500.0);

        double hAsl0 = GetElevation(lat0, lon0) + hAgl;
        double maxRM = rangeKm * 1000.0;

        bool fullCircle = (azMax - azMin) >= 359.9;
        var azimuths   = fullCircle
            ? MakeAngles(0.0, 360.0 - azStep, azStep)
            : MakeAngles(azMin, azMax, azStep);
        var elevations = MakeAngles(elMin, elMax, elStep);

        int nAz = azimuths.Count;
        int nEl = elevations.Count;

        // Ray trace — [az][el]
        var gridLon  = new double[nAz, nEl];
        var gridLat  = new double[nAz, nEl];
        var gridAlt  = new double[nAz, nEl];
        var gridRng  = new double[nAz, nEl];
        var gridHit  = new bool  [nAz, nEl];

        for (int i = 0; i < nAz; i++)
        {
            for (int j = 0; j < nEl; j++)
            {
                var r = TraceRay(lat0, lon0, hAsl0,
                                 azimuths[i], elevations[j], maxRM, rayStep);
                gridLon[i, j] = r.Lon;
                gridLat[i, j] = r.Lat;
                gridAlt[i, j] = r.AltAsl;
                gridRng[i, j] = r.RangeM;
                gridHit[i, j] = r.TerrainHit;
            }
        }

        // Flatten to vertex array
        var verts = new List<double[]>(nAz * nEl);
        var idx   = new int[nAz, nEl];
        for (int i = 0; i < nAz; i++)
            for (int j = 0; j < nEl; j++)
            {
                idx[i, j] = verts.Count;
                verts.Add([gridLon[i, j], gridLat[i, j], gridAlt[i, j]]);
            }

        // Build triangles — skip quads that straddle terrain-shadow boundaries
        const double ShadowRatio = 1.5;
        var tris   = new List<int[]>((nAz - 1) * (nEl - 1) * 2);
        int azIMax = fullCircle ? nAz : nAz - 1;

        for (int i = 0; i < azIMax; i++)
        {
            int ni = fullCircle ? (i + 1) % nAz : i + 1;
            for (int j = 0; j < nEl - 1; j++)
            {
                bool h00 = gridHit[i,  j],   h10 = gridHit[ni, j];
                bool h01 = gridHit[i,  j+1], h11 = gridHit[ni, j+1];

                if ((h00 || h10 || h01 || h11) && !(h00 && h10 && h01 && h11))
                {
                    double rMin = Math.Min(Math.Min(gridRng[i,j],   gridRng[ni,j]),
                                           Math.Min(gridRng[i,j+1], gridRng[ni,j+1]));
                    double rMax = Math.Max(Math.Max(gridRng[i,j],   gridRng[ni,j]),
                                           Math.Max(gridRng[i,j+1], gridRng[ni,j+1]));
                    if (rMin > 0.0 && rMax > ShadowRatio * rMin) continue;
                }

                int a = idx[i, j],  b = idx[ni, j];
                int c = idx[i, j+1], d = idx[ni, j+1];
                tris.Add([a, b, d]);
                tris.Add([a, d, c]);
            }
        }

        double secAz  = fullCircle ? 0.0 : (azMin + azMax) / 2.0;
        var    section = ComputeSection(lat0, lon0, hAsl0,
                                        secAz, elMax, rangeKm, rayStep);

        var result = new
        {
            vertices  = verts,
            triangles = tris,
            section,
            meta = new
            {
                lat         = lat0,
                lon         = lon0,
                alt_asl     = hAsl0,
                range_km    = rangeKm,
                n_az        = nAz,
                n_el        = nEl,
                full_circle = fullCircle,
                n_vertices  = verts.Count,
                n_triangles = tris.Count,
            },
        };
        return JsonSerializer.Serialize(result);
    }

    // -------------------------------------------------------------------------
    // Section-only path
    // -------------------------------------------------------------------------

    private string RunSection(JsonElement p)
    {
        double lat0     = p.GetProperty("lat").GetDouble();
        double lon0     = p.GetProperty("lon").GetDouble();
        double hAsl0    = GetElevation(lat0, lon0) + p.GetProperty("height_agl").GetDouble();
        double azDeg    = GetOrDefault(p, "az_deg",    0.0);
        double elMax    = p.GetProperty("el_max").GetDouble();
        double rangeKm  = p.GetProperty("range_km").GetDouble();
        double rayStep  = GetOrDefault(p, "ray_step_m", 500.0);

        var sec = ComputeSection(lat0, lon0, hAsl0,
                                 azDeg, elMax, rangeKm, rayStep);
        return JsonSerializer.Serialize(new { section = sec });
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static double GetOrDefault(JsonElement p, string key, double def)
    {
        if (p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number)
            return v.GetDouble();
        return def;
    }
}
