# HaLab Plots — R side. Runs inside webR in the browser; js/r-engine.js calls these functions.
# A figure file is a saveRDS() of a ggplot / patchwork / pheatmap / ComplexHeatmap (Heatmap or HeatmapList) / grid grob,
# or of list(plot = <one of those>, table = <data frame or matrix>) to attach a data table.
# Base R graphics (plot(), corrplot, …) can't be saved as an object, so they come as the drawing function and its data:
# list(plot = function(d) corrplot::corrplot(d), data = <its argument>, table = <optional; default: data>).

fb <- new.env()   # figures loaded so far: fb$figs[[id]] = list(plot, table, kind, data, built)
fb$figs <- list()
fb_get <- function(id) fb$figs[[id]] %||% stop("This figure isn't loaded yet.")

# Drawing a gtable (pheatmap's figure) needs gtable's methods, and readRDS alone doesn't load the package
loadNamespace("gtable")

fb_need <- function(pkgs, repos = NULL) {
  miss <- Filter(function(p) !nzchar(system.file(package = p)), unique(pkgs))
  if (length(miss)) try(webr::install(miss, repos = repos, quiet = TRUE), silent = TRUE)
}

# readRDS, installing any package the object refers to that webR doesn't have yet (e.g. cowplot)
fb_read <- function(path) {
  miss <- character()
  obj <- withCallingHandlers(readRDS(path), warning = function(w) {
    m <- regmatches(conditionMessage(w), regexec("namespace .([A-Za-z0-9.]+). is not available", conditionMessage(w)))[[1]]
    if (length(m) == 2) {
      miss <<- c(miss, m[2])
      invokeRestart("muffleWarning")
    }
  })
  # A ComplexHeatmap holds functions from its packages (circlize colour scales) that come back whole only when those
  # packages are loaded before reading. Bioconductor isn't in webR's own repository; r-universe builds it for webR.
  x <- if (identical(class(obj), "list")) obj$plot else obj
  if (isS4(x) && identical(attr(class(x), "package"), "ComplexHeatmap")) {
    fb_need("ComplexHeatmap", c("https://bioc.r-universe.dev", "https://repo.r-wasm.org"))
    loadNamespace("ComplexHeatmap")
    return(suppressWarnings(readRDS(path)))
  }
  if (length(miss)) {
    try(webr::install(unique(miss), quiet = TRUE), silent = TRUE)
    obj <- suppressWarnings(readRDS(path))
  }
  obj
}

fb_unwrap <- function(x) {
  table <- data <- NULL
  if (is.list(x) && !inherits(x, c("gg", "grob", "pheatmap")) && !is.null(x$plot)) {
    table <- x$table
    data <- x$data
    x <- x$plot
  }
  kind <- if (inherits(x, "pheatmap")) "pheatmap" else if (inherits(x, "patchwork")) "patchwork" else
    if (inherits(x, "ggplot")) "ggplot" else if (inherits(x, "grob")) "grob" else if (is.function(x)) "base" else
    if (inherits(x, c("Heatmap", "HeatmapList"))) "complexheatmap" else
    stop("Not a ggplot, patchwork, pheatmap, ComplexHeatmap, grid grob or plotting function.")
  if (kind == "pheatmap") x <- x$gtable
  # a ggplot carries its own data, a base R figure its function's data, a ComplexHeatmap its (first) matrix;
  # pheatmap and patchwork need list(plot =, table =)
  if (is.null(table) && kind == "ggplot" && is.data.frame(x$data)) table <- x$data
  if (is.null(table) && kind == "base" && (is.data.frame(data) || is.matrix(data))) table <- data
  if (is.null(table) && kind == "complexheatmap") {
    h <- if (inherits(x, "Heatmap")) x else Find(function(h) inherits(h, "Heatmap"), x@ht_list)
    if (!is.null(h)) table <- h@matrix
  }
  if (!is.null(table)) table <- as.data.frame(table)
  if (!is.null(table) && !nrow(table)) table <- NULL
  list(plot = x, table = table, kind = kind, data = data)
}

fb_load <- function(path, id) {
  f <- fb_unwrap(fb_read(path))
  if (f$kind == "ggplot") f$built <- ggplot2::ggplot_build(f$plot)
  if (f$kind == "base") {
    fb_need(c("gridGraphics", fb_pkgs(f$plot)))
    ps <- fb_try(f)
  }
  fb$figs[[id]] <- f
  info <- list(kind = f$kind, rows = 0L, cols = 0L)
  if (!is.null(f$table)) info[c("rows", "cols")] <- dim(f$table)
  # base R draws text at the device's point size (12) unless the function sets its own par(ps =)
  if (f$kind == "base" && ps == 12) info$size <- 12
  if (f$kind %in% c("ggplot", "patchwork")) {
    size <- tryCatch(ggplot2::calc_element("text", ggplot2::complete_theme(f$plot$theme))$size, error = function(e) NULL)
    if (is.numeric(size)) info$size <- size
  }
  if (f$kind == "ggplot") {
    keys <- c("title", "subtitle", "caption", "x", "y", "colour", "fill", "shape", "size", "linetype", "alpha")
    labs <- ggplot2::get_labs(f$plot)[keys]
    names(labs) <- keys
    # only plain text labels are editable; expression labels (plotmath) are left as they are
    info$labels <- Filter(function(v) is.character(v) && length(v) == 1, labs)
    info$style <- fb_style(f$plot, f$built)
  }
  if (f$kind %in% c("ggplot", "patchwork") && !is.null(info$size)) {
    axes <- c("axis_title_x", "axis_title_y", "axis_text_x", "axis_text_y")
    kinds <- if (f$kind == "patchwork") c(axes, "legend_title", "legend_text", "strip") else
      c(intersect(c("title", "subtitle", "caption"), names(info$labels)), axes,
        if (f$built$plot$scales$non_position_scales()$n() > 0) c("legend_title", "legend_text"),
        if (!inherits(f$plot$facet, "FacetNull")) "strip")
    info$text <- fb_text_info(f$plot$theme, kinds, info$size)
  }
  if (f$kind == "pheatmap") {
    pal <- fb_heat_palette(f$plot)
    if (length(pal)) info$heat <- lapply(list(low = 1, mid = ceiling(length(pal) / 2), high = length(pal)), function(i) fb_hex(pal[i]))
  }
  jsonlite::toJSON(info, auto_unbox = TRUE)
}

# ---------- style ----------
# What can be changed per kind of layer: name on the page, settings. A layer takes the first of its geom's classes found here.
FB_GEOMS <- list(
  GeomPoint      = list("Points", c("size", "alpha", "colour")),
  GeomBar        = list("Bars", c("width", "alpha", "fill")),          # also geom_col, geom_histogram
  GeomBoxplot    = list("Boxes", c("width", "alpha", "fill")),
  GeomViolin     = list("Violins", c("width", "alpha", "fill")),
  GeomDotplot    = list("Dots", c("dotsize", "alpha", "fill")),
  GeomErrorbar   = list("Error bars", c("width", "linewidth", "colour", "linetype")),
  GeomTextRepel  = list("Text labels", c("show", "size_pt", "colour")),
  GeomLabelRepel = list("Text labels", c("show", "size_pt", "colour")),
  GeomText       = list("Text labels", c("show", "size_pt", "colour")),
  GeomLabel      = list("Text labels", c("show", "size_pt", "colour")),
  GeomSmooth     = list("Trend line", c("linewidth", "colour", "linetype")),
  GeomVline      = list("Reference line", c("linewidth", "colour", "linetype")),
  GeomHline      = list("Reference line", c("linewidth", "colour", "linetype")),
  GeomAbline     = list("Reference line", c("linewidth", "colour", "linetype")),
  GeomSegment    = list("Segments", c("linewidth", "colour", "linetype")),        # also geom_curve
  GeomPath       = list("Lines", c("linewidth", "alpha", "colour", "linetype")),  # also geom_line, geom_step
  GeomRibbon     = list("Areas", c("alpha", "fill"))                              # also geom_area, geom_density
)

# Text parts that can be resized or turned off → the theme elements they set: every one the text can be drawn
# with, so a setting the figure made for one of them doesn't win. The first is the one whose size is shown.
FB_TEXT <- list(
  title = "plot.title", subtitle = "plot.subtitle", caption = "plot.caption",
  axis_title_x = c("axis.title.x.bottom", "axis.title.x", "axis.title.x.top"),
  axis_title_y = c("axis.title.y.left", "axis.title.y", "axis.title.y.right"),
  axis_text_x = c("axis.text.x.bottom", "axis.text.x", "axis.text.x.top"),
  axis_text_y = c("axis.text.y.left", "axis.text.y", "axis.text.y.right"),
  legend_title = "legend.title", legend_text = "legend.text",
  strip = c("strip.text.x.top", "strip.text.x", "strip.text.x.bottom", "strip.text.y.right", "strip.text.y", "strip.text.y.left")
)
fb_text_els <- function(k) intersect(FB_TEXT[[k]], names(ggplot2::get_element_tree()))
fb_theme <- function(els, el) do.call(ggplot2::theme, stats::setNames(rep(list(el), length(els)), els))

# Per text part: the size (pt) it is drawn at (or would be, turned on), whether that follows the base font size
# (sizes set with rel()), and whether it is shown
fb_text_info <- function(th, kinds, base) {
  size_at <- function(el, b) {
    t <- th + ggplot2::theme(text = ggplot2::element_text(size = b))
    e <- ggplot2::calc_element(el, ggplot2::complete_theme(t))
    if (!inherits(e, "element_text")) e <- ggplot2::calc_element(el, ggplot2::complete_theme(t + fb_theme(el, ggplot2::element_text())))
    e$size
  }
  out <- list()
  for (k in kinds) {
    el <- fb_text_els(k)[1]
    s <- tryCatch(c(size_at(el, base), size_at(el, 2 * base)), error = function(e) NULL)
    if (length(s) != 2) next
    out[[k]] <- list(size = round(s[1], 2), rel = isTRUE(all.equal(s[2], 2 * s[1])),
                     show = inherits(ggplot2::calc_element(el, ggplot2::complete_theme(th)), "element_text"))
  }
  out
}

fb_lty <- function(v) if (is.numeric(v)) c("blank", "solid", "dashed", "dotted", "dotdash", "longdash", "twodash")[v + 1] else as.character(v)

# A continuous size scale's palette (scale_size, scale_radius) keeps its size range in its environment.
# Taken from a built plot it comes wrapped as a ggproto method, maybe more than once.
fb_pal <- function(s) {
  f <- s$palette
  while (inherits(f, "ggproto_method")) f <- environment(f)$f
  f
}
fb_pal_range <- function(s) {
  e <- environment(fb_pal(s))
  r <- if (is.environment(e)) get0("range", e, inherits = FALSE)
  if (is.numeric(r) && length(r) == 2) r
}

fb_hex <- function(x) {
  x <- x[!is.na(x)]
  if (!length(x)) return("#999999")
  m <- grDevices::col2rgb(x[1])
  grDevices::rgb(m[1], m[2], m[3], maxColorValue = 255)
}

# Current values, read from the built plot. A setting that varies with the data is left out
# (colour/fill mapped to a variable are changed through its scale instead).
fb_style <- function(p, b) {
  layers <- list()
  for (i in seq_along(p$layers)) {
    l <- p$layers[[i]]
    hit <- intersect(class(l$geom), names(FB_GEOMS))
    if (!length(hit)) next
    g <- FB_GEOMS[[hit[1]]]
    params <- list()
    for (k in g[[2]]) {
      if (k == "width") {
        params$width <- l$geom_params$width %||% l$aes_params$width %||% l$stat_params$width %||% 0.9
        next
      }
      if (k == "dotsize") {
        params$dotsize <- l$geom_params$dotsize %||% 1
        next
      }
      if (k == "show") {   # turning a layer off leaves it out (fb_edit)
        params$show <- TRUE
        next
      }
      v <- unique(b$data[[i]][[if (k == "size_pt") "size" else k]])
      if (length(v) != 1) next
      if (k == "linetype" && is.na(v <- fb_lty(v))) next
      params[[k]] <- switch(k, colour = , fill = fb_hex(v), alpha = if (is.na(v)) 1 else v,
                            size_pt = round(v * ggplot2::.pt, 1), v)
    }
    if (length(params)) layers[[length(layers) + 1]] <- list(i = i, name = g[[1]], params = params)
  }
  scales <- list()
  for (a in c("colour", "fill")) {
    s <- b$plot$scales$get_scales(a)
    if (is.null(s) || inherits(s, c("ScaleDiscreteIdentity", "ScaleContinuousIdentity", "ScaleBinned"))) next
    name <- ggplot2::get_labs(p)[[a]]
    name <- if (is.character(name) && length(name) == 1) name else a
    if (s$is_discrete()) {
      lv <- s$get_limits()
      if (!length(lv) || length(lv) > 40) next
      scales[[a]] <- list(type = "discrete", name = name, levels = as.list(as.character(lv)), colors = lapply(s$map(lv), fb_hex))
    } else {
      lim <- s$get_limits()
      if (length(lim) != 2 || any(!is.finite(lim))) next
      scales[[a]] <- list(type = "continuous", name = name, limits = lim,
                          low = fb_hex(s$map(lim[1])), mid = fb_hex(s$map(mean(lim))), high = fb_hex(s$map(lim[2])))
    }
  }
  # dot plots with the dot size mapped to a variable (e.g. Seurat's DotPlot): the smallest and largest dot
  s <- b$plot$scales$get_scales("size")
  r <- if (!is.null(s) && !s$is_discrete()) fb_pal_range(s)
  if (length(r) == 2) {
    name <- ggplot2::get_labs(p)$size
    scales$size <- list(type = "range", name = if (is.character(name) && length(name) == 1) name else "size", range = r)
  }
  list(layers = layers, scales = scales)
}

fb_layer <- function(p, i, v) {
  # A full copy, so the figure as loaded stays unchanged. (Not ggproto(NULL, layer): after a layer has been
  # drawn once, building such a child overflows the stack in ggplot2 4.0.)
  l <- unserialize(serialize(p$layers[[i]], NULL))
  v$show <- NULL   # a layer turned off is left out in fb_edit
  if (!is.null(v$dotsize)) {
    l$geom_params$dotsize <- v$dotsize
    v$dotsize <- NULL
  }
  if (!is.null(v$size_pt)) {
    v$size <- v$size_pt / ggplot2::.pt
    v$size_pt <- NULL
  }
  if (!is.null(v$width)) {
    l$geom_params$width <- v$width
    if ("width" %in% l$stat$parameters()) l$stat_params$width <- v$width   # geom_bar, geom_boxplot work it out in the stat
    if (!is.null(l$aes_params$width)) l$aes_params$width <- v$width
    v$width <- NULL
  }
  if (length(v)) l$aes_params <- utils::modifyList(l$aes_params, v)
  p$layers[[i]] <- l
  p
}

# v: list(type = "discrete", values = list(level = colour)), list(type = "continuous", n = 2|3, low, mid, high, midpoint)
#    or, for size, list(type = "range", range = c(smallest, largest))
fb_scale <- function(p, a, v, built) {
  old <- built$plot$scales$get_scales(a)
  if (v$type == "range") {   # the same kind of size scale (area or radius), another size range
    s <- old$clone()
    pal <- fb_pal(old)
    environment(pal) <- list2env(list(range = as.numeric(unlist(v$range))), parent = environment(pal))
    s$palette <- pal
    return(suppressMessages(p + s))
  }
  keep <- list(name = old$name, breaks = old$breaks, labels = old$labels, guide = old$guide, na.value = old$na.value, limits = old$limits)
  pick <- function(stem) getExportedValue("ggplot2", paste0("scale_", a, "_", stem))
  sc <- if (v$type == "discrete") do.call(pick("manual"), c(list(values = unlist(v$values)), keep)) else
    if (identical(as.numeric(v$n), 2)) do.call(pick("gradient"), c(list(low = v$low, high = v$high, oob = old$oob), keep)) else
    do.call(pick("gradient2"), c(list(low = v$low, mid = v$mid, high = v$high, midpoint = v$midpoint %||% 0, oob = old$oob), keep))
  suppressMessages(p + sc)
}

# pheatmap draws fixed colours. Every cell's colour is one of the legend's colours, so recolouring the
# legend palette (same breaks) and swapping each cell's colour by its place in it gives the new heatmap.
fb_heat_palette <- function(g) {
  li <- which(g$layout$name == "legend")
  if (!length(li)) return(NULL)
  r <- Filter(function(x) inherits(x, "rect"), g$grobs[[li]]$children)
  if (length(r)) r[[1]]$gp$fill
}

fb_heat <- function(g, h) {
  old <- fb_heat_palette(g)
  if (is.null(old)) return(g)
  cols <- unlist(if (identical(as.numeric(h$n), 2)) h[c("low", "high")] else h[c("low", "mid", "high")])
  new <- grDevices::colorRampPalette(cols)(length(old))
  recolour <- function(x) {
    if (!inherits(x, "rect")) return(x)
    f <- x$gp$fill
    idx <- match(f, old)
    f[!is.na(idx)] <- new[idx[!is.na(idx)]]   # NA cells (na_col) are not in the palette and stay as they were
    x$gp$fill <- f
    x
  }
  for (nm in c("legend", "matrix")) {
    j <- which(g$layout$name == nm)
    if (length(j)) g$grobs[[j]]$children <- do.call(grid::gList, lapply(g$grobs[[j]]$children, recolour))
  }
  g
}

# f: a loaded figure (fb_get). e: list(labels = list(x = "...", ...), size = <base font size in pt>,
#   text = list(axis_text_x = list(show = TRUE/FALSE, size = <pt>), ...) (FB_TEXT),
#   layers = list("<i>" = list(size = .., show = FALSE, ...)), scales = list(colour = .., fill = .., size = ..),
#   heat = list(n, low, mid, high)). "" removes a label.
fb_edit <- function(f, e) {
  p <- f$plot
  if (f$kind == "pheatmap") return(if (is.null(e$heat)) p else fb_heat(p, e$heat))
  if (f$kind == "complexheatmap") return(p)
  if (f$kind == "ggplot") {
    # settings are kept per figure in the browser; after the file is re-saved a layer or scale may be gone
    for (i in names(e$layers)) if (as.integer(i) <= length(p$layers)) p <- fb_layer(p, as.integer(i), e$layers[[i]])
    for (a in names(e$scales)) if (!is.null(f$built$plot$scales$get_scales(a))) p <- fb_scale(p, a, e$scales[[a]], f$built)
    off <- as.integer(names(Filter(function(v) isFALSE(v$show), e$layers)))
    off <- off[off <= length(p$layers)]
    if (length(off)) p$layers <- p$layers[-off]
  }
  if (length(e$labels)) p <- p + do.call(ggplot2::labs, lapply(e$labels, function(v) if (identical(v, "")) NULL else v))
  th <- list()
  if (!is.null(e$size)) th <- list(ggplot2::theme(text = ggplot2::element_text(size = e$size)))
  for (k in names(e$text)) {
    v <- e$text[[k]]
    th[[length(th) + 1]] <- fb_theme(fb_text_els(k), if (isFALSE(v$show)) ggplot2::element_blank() else ggplot2::element_text(size = v$size))
  }
  for (t in th) p <- if (f$kind == "patchwork") p & t else p + t
  p
}

# ---------- base R ----------
# Packages the saved function calls as pkg::fun. (A function saved from a script doesn't bring library() along.)
fb_pkgs <- function(fn) {
  n <- all.names(body(fn))
  unique(n[which(n %in% c("::", ":::")) + 1])
}

fb_call <- function(f) if (is.null(f$data)) f$plot() else f$plot(f$data)

# Runs the function once off screen, so a broken file says why when it is opened. → the point size it ended with
fb_try <- function(f) {
  grDevices::pdf(NULL, 7, 5, pointsize = 12)
  on.exit(grDevices::dev.off())
  tryCatch(fb_call(f), error = function(e) {
    m <- conditionMessage(e)
    stop(m, if (grepl("could not find function", m)) " — write it as package::function inside the saved function" else
      if (grepl("not found", m)) " — the saved function can only use its argument (the data saved with it)", call. = FALSE)
  })
  graphics::par("ps")
}

# Base graphics can't draw into a grid viewport, so the function draws on an off-screen device of the viewport's size
# and gridGraphics redraws that with grid. gridGraphics takes text size from the viewport, not from par("ps"),
# so the off-screen devices and the viewport get the same point size (then it matches drawing straight to a file).
fb_echo <- function(f, size) {
  w <- grid::convertWidth(grid::unit(1, "npc"), "in", valueOnly = TRUE)
  h <- grid::convertHeight(grid::unit(1, "npc"), "in", valueOnly = TRUE)
  dev <- function(w, h) {   # white like the file devices: legend() fills its box with par("bg")
    grDevices::pdf(NULL, width = w, height = h, pointsize = size, bg = "white")
    grDevices::dev.control("enable")
  }
  cur <- grDevices::dev.cur()
  dev(w, h)
  rec <- tryCatch({
    fb_call(f)
    list(plot = grDevices::recordPlot(), ps = graphics::par("ps"))
  }, finally = {
    grDevices::dev.off()
    grDevices::dev.set(cur)
  })
  # gridGraphics places axes in device inches, right only when the figure starts at the device's corner (not so for
  # a panel of a combined figure): redraw on a device of the figure's size, keep what was drawn, and draw that here.
  # Its viewports are found by name, so each echo gets its own.
  fb$echoes <- (fb$echoes %||% 0) + 1
  g <- grid::grid.grabExpr({
    grid::pushViewport(grid::viewport(gp = grid::gpar(fontsize = rec$ps)))
    gridGraphics::grid.echo(rec$plot, newpage = FALSE, prefix = paste0("fb", fb$echoes, "-"), device = dev)
  }, width = w, height = h, device = dev)
  grid::pushViewport(grid::viewport(clip = "on"))   # its background is painted 1.5 times the figure's size
  grid::grid.draw(g)
  grid::popViewport()
}

# Draws into the current grid viewport (a whole page, or one panel of a combined figure)
fb_draw <- function(f, e) {
  p <- if (f$kind != "base") fb_edit(f, e)
  set.seed(1)   # ggrepel places labels at random; a fixed seed keeps the preview and the file alike
  if (f$kind == "base") fb_echo(f, e$size %||% 12) else
    if (f$kind %in% c("ggplot", "patchwork")) print(p, newpage = FALSE) else
    if (f$kind == "complexheatmap") ComplexHeatmap::draw(p, newpage = FALSE) else grid::grid.draw(p)
}

# w, h in inches; dpi only matters for raster formats
fb_device <- function(path, fmt, w, h, dpi) {
  switch(fmt,
    png  = ragg::agg_png(path, w, h, units = "in", res = dpi),
    jpeg = ragg::agg_jpeg(path, w, h, units = "in", res = dpi, quality = 95),
    tiff = ragg::agg_tiff(path, w, h, units = "in", res = dpi, compression = "lzw"),
    pdf  = grDevices::cairo_pdf(path, w, h),
    svg  = svglite::svglite(path, w, h),
    stop("Unknown format: ", fmt))
  grid::grid.newpage()
}

fb_save <- function(path, fmt, w, h, dpi, edits, id) {
  f <- fb_get(id)
  fb_device(path, fmt, w, h, dpi)
  on.exit(grDevices::dev.off())
  fb_draw(f, jsonlite::fromJSON(edits, simplifyVector = FALSE))
  invisible()
}

# A combined figure. spec: list(panels = list(list(id, x, y, w, h (inches from the top left), edits, letter)),
#                              letters = list(size = <pt>, bold = TRUE/FALSE))
# A panel drawn by Python comes as list(img = <PNG file>, x, y, w, h, letter) and is placed as a picture.
fb_page <- function(path, fmt, w, h, dpi, spec) {
  s <- jsonlite::fromJSON(spec, simplifyVector = FALSE)
  if (any(vapply(s$panels, function(pn) !is.null(pn$img), TRUE))) fb_need("png")
  fb_device(path, fmt, w, h, dpi)
  on.exit(grDevices::dev.off())
  u <- function(v) grid::unit(v, "in")
  for (pn in s$panels) {
    grid::pushViewport(grid::viewport(x = u(pn$x), y = u(h - pn$y), width = u(pn$w), height = u(pn$h), just = c("left", "top")))
    if (is.null(pn$img)) fb_draw(fb_get(pn$id), pn$edits) else   # native: 4 bytes a pixel instead of 32
      grid::grid.raster(png::readPNG(pn$img, native = TRUE), width = grid::unit(1, "npc"), height = grid::unit(1, "npc"), interpolate = FALSE)
    grid::popViewport()
  }
  for (pn in s$panels) if (nzchar(pn$letter %||% ""))   # letters last, so no panel covers them
    grid::grid.text(pn$letter, x = u(pn$x), y = u(h - pn$y), just = c("left", "top"),
                    gp = grid::gpar(fontsize = s$letters$size, fontface = if (isTRUE(s$letters$bold)) "bold" else "plain"))
  invisible()
}

fb_table <- function(path, fmt, id) {
  t <- fb_get(id)$table
  t[] <- lapply(t, function(col) if (is.list(col)) vapply(col, function(v) paste(format(v), collapse = ";"), "") else col)
  rn <- is.character(attr(t, "row.names"))   # gene names etc.; plain row numbers are dropped
  out <- utils::capture.output(if (fmt == "csv") utils::write.csv(t, row.names = rn) else
    utils::write.table(t, sep = "\t", quote = FALSE, row.names = rn, col.names = if (rn) NA else TRUE))
  writeLines(out, path, useBytes = TRUE)
}
