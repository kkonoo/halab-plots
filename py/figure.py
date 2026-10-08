# HaLab Plots — Python side. Runs inside Pyodide in the browser; js/py-engine.js calls these functions.
# A figure file (.pkl) is a pickle.dump() of a matplotlib Figure (or anything with .figure: Axes, seaborn grids),
# or of {"plot": <one of those>, "table": <pandas DataFrame>} to attach a data table.
# Pickles open safely only in the matplotlib version they were saved with: here 3.10.

import io, json, pickle, warnings
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot  # a figure made with pyplot comes back registered with pyplot
from matplotlib import font_manager
from matplotlib.figure import Figure
import pyodide_js

FIGS = {}  # figures loaded so far: FIGS[id] = {"fig", "table"}


# The fonts the R side uses too: the viewer's own Arial (when allowed) or Arimo, with the same letter widths.
# sans-serif, Arial and Helvetica → main, then Arimo, then DejaVu Sans for anything they lack (Greek, symbols).
def fb_fonts(paths, main):
    import dataclasses
    for p in paths:
        font_manager.fontManager.addfont(p)
    faces = [e for e in font_manager.fontManager.ttflist if e.name == main]
    for alias in {"Arial", "Helvetica"} - {main}:
        font_manager.fontManager.ttflist += [dataclasses.replace(e, name=alias) for e in faces]
    matplotlib.rcParams["font.sans-serif"] = [main, "Arimo", "DejaVu Sans"]
    # text stays text: TrueType in PDF (journals ask for it), real text in SVG, as R's files have
    matplotlib.rcParams.update({"pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none"})


# Unpickling imports the modules the figure refers to (pandas for a table, seaborn, …): load the missing ones and try again
async def fb_unpickle(data):
    tried = set()
    while True:
        try:
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                return pickle.loads(data), [str(x.message) for x in w]
        except ModuleNotFoundError as e:
            name = (e.name or "").split(".")[0]
            if not name or name in tried:
                raise RuntimeError(f"This figure needs the Python package “{name}”, which can't be loaded here.") from None
            tried.add(name)
            await pyodide_js.loadPackagesFromImports(f"import {name}")
            try:
                __import__(name)
            except ModuleNotFoundError:  # not one of Pyodide's own packages: a pure-Python one may come from PyPI
                try:
                    await pyodide_js.loadPackage("micropip")
                    import micropip
                    await micropip.install(name)
                except Exception:
                    pass  # the next try says which package is missing


async def fb_load(data, id):
    obj, notes = await fb_unpickle(data.to_bytes())
    table = None
    if isinstance(obj, dict):
        table = obj.get("table")
        obj = obj.get("plot")
    fig = obj if isinstance(obj, Figure) else getattr(obj, "figure", None)
    if not isinstance(fig, Figure):
        raise RuntimeError("Not a matplotlib figure. Save the Figure (fig), or {'plot': fig, 'table': df}.")
    if table is not None and not hasattr(table, "to_csv"):
        await pyodide_js.loadPackage("pandas")
        import pandas
        table = pandas.DataFrame(table)
    if table is not None and not len(table):
        table = None
    FIGS[id] = {"fig": fig, "table": table}
    info = {"kind": "matplotlib", "rows": 0, "cols": 0, "mpl": matplotlib.__version__}
    if table is not None:
        info["rows"], info["cols"] = table.shape if table.ndim == 2 else (len(table), 1)
    saved = [n for n in notes if "saved with matplotlib version" in n]
    if saved:
        info["saved"] = saved[0].split("version ")[1].split()[0]
    return json.dumps(info)


def fb_get(id):
    if id not in FIGS:
        raise RuntimeError("This figure isn't loaded yet.")
    return FIGS[id]


# w, h in inches; dpi only matters for raster formats. Text keeps its point size; a figure made with
# layout="constrained" (or tight) lays itself out again for the new size.
def fb_save(id, fmt, w, h, dpi):
    fig = fb_get(id)["fig"]
    fig.set_size_inches(w, h)
    kw = {"jpeg": {"pil_kwargs": {"quality": 95}}, "tiff": {"pil_kwargs": {"compression": "tiff_lzw"}}}.get(fmt, {})
    buf = io.BytesIO()
    fig.savefig(buf, format=fmt, dpi=dpi, **kw)
    return buf.getvalue()


def fb_table(id, fmt):
    t = fb_get(id)["table"]
    named = type(t.index).__name__ != "RangeIndex"  # gene names etc.; plain row numbers are dropped
    text = t.to_csv(index=named) if fmt == "csv" else t.to_csv(sep="\t", index=named)
    return text.encode()
