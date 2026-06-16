(function () {
  const cities = window.METRO_CITY_DATA.cities;
  const cityById = new Map(cities.map((city) => [city.id, city]));
  const homeView = document.getElementById("home-view");
  const mapView = document.getElementById("map-view");
  const provinceFilter = document.getElementById("province-filter");
  const citySearch = document.getElementById("city-search");
  const cityGrid = document.getElementById("city-grid");
  const cityTitle = document.getElementById("city-title");
  const citySubtitle = document.getElementById("city-subtitle");
  const mapTopbar = document.getElementById("map-topbar");
  const lineLegend = document.getElementById("line-legend");
  const styleSelect = document.getElementById("style-select");
  const lineFilters = document.getElementById("line-filters");
  const stationSearch = document.getElementById("station-search");
  const toggleStations = document.getElementById("toggle-stations");
  const toggleLabels = document.getElementById("toggle-labels");
  const toggleLines = document.getElementById("toggle-lines");
  const collapseTopbar = document.getElementById("collapse-topbar");
  const collapseLegend = document.getElementById("collapse-legend");

  const styleConfigs = {
    "osm-muted": {
      name: "OSM muted",
      crs: "wgs84",
      muted: true,
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    "osm-colorful": {
      name: "OSM colorful",
      crs: "wgs84",
      muted: false,
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    "google-road": {
      name: "Google road",
      crs: "gcj02",
      muted: false,
      url: "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
      options: {
        subdomains: ["0", "1", "2", "3"],
        maxZoom: 19,
        attribution: "Basemap &copy; Google",
      },
    },
    "google-satellite": {
      name: "Google satellite",
      crs: "gcj02",
      muted: false,
      url: "https://mt{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}",
      options: {
        subdomains: ["0", "1", "2", "3"],
        maxZoom: 19,
        attribution: "Basemap &copy; Google",
      },
    },
  };

  let map;
  let tileLayer;
  let activeCity;
  let lineLayers = new Map();
  let lineLabels = new Map();
  let stationMarkers = [];
  let stationLabels = [];
  let activeBounds = L.latLngBounds([]);
  let stationsVisible = true;
  let labelsVisible = true;
  let linesVisible = true;
  let highlightedStation = null;
  const stationLabelMinZoom = 12;

  function provinceOptions() {
    const provinces = [...new Map(cities.map((city) => [city.province, city.province_en])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    provinceFilter.innerHTML = '<option value="">All provinces</option>';
    provinces.forEach(([province, provinceEn]) => {
      const option = document.createElement("option");
      option.value = province;
      option.textContent = provinceEn;
      provinceFilter.append(option);
    });
  }

  function renderCityCards() {
    const province = provinceFilter.value;
    const query = citySearch.value.trim().toLowerCase();
    cityGrid.innerHTML = "";
    cities
      .filter((city) => !province || city.province === province)
      .filter((city) => {
        if (!query) return true;
        return [city.name, city.name_en, city.province, city.province_en]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .forEach((city) => {
        const button = document.createElement("button");
        button.className = "city-card";
        button.type = "button";
        button.innerHTML = `
          <div class="mini-map" aria-hidden="true"></div>
          <h2>${city.name_en}</h2>
          <p class="meta">${city.province_en} · ${city.line_count} lines · ${city.station_count} stations</p>
        `;
        button.addEventListener("click", () => openCity(city.id, true));
        cityGrid.append(button);
      });
  }

  function ensureMap() {
    if (map) return;
    map = L.map("map", { zoomControl: false, preferCanvas: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomright", metric: true, imperial: false }).addTo(map);
    const northControl = L.control({ position: "bottomright" });
    northControl.onAdd = () => {
      const container = L.DomUtil.create("div", "north-arrow");
      container.innerHTML = '<span class="north-arrow-symbol">↑</span><span>N</span>';
      container.title = "North";
      return container;
    };
    northControl.addTo(map);
    map.on("zoomend", updateStationLabels);
  }

  function setTileLayer() {
    const config = styleConfigs[styleSelect.value];
    if (tileLayer) tileLayer.remove();
    tileLayer = L.tileLayer(config.url, config.options).addTo(map);
    const pane = map.getPane("tilePane");
    pane.classList.toggle("muted-tiles", config.muted);
  }

  function currentGeometry(feature) {
    const config = styleConfigs[styleSelect.value];
    return config.crs === "gcj02" ? feature.geometry_gcj02 : feature.geometry;
  }

  function featureForDisplay(feature) {
    return {
      type: "Feature",
      properties: feature.properties,
      geometry: currentGeometry(feature),
    };
  }

  function asColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
  }

  function displayLineRef(lineRef) {
    const special = {
      大兴机场: "Daxing Airport",
    };
    return special[lineRef] || lineRef;
  }

  function midpointOfGeometry(geometry) {
    const coords = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
    const index = Math.floor(coords.length / 2);
    return [coords[index][1], coords[index][0]];
  }

  function pointSegmentDistanceSq(point, start, end) {
    const [px, py] = point;
    const [ax, ay] = start;
    const [bx, by] = end;
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const x = ax + t * dx;
    const y = ay + t * dy;
    return (px - x) ** 2 + (py - y) ** 2;
  }

  function selectedLineRefs() {
    return new Set([...lineFilters.querySelectorAll("input:checked")].map((input) => input.value));
  }

  function stationNearLine(point, lineRefs) {
    if (!lineRefs.size) return false;
    if (lineRefs.size === lineLayers.size) return true;
    const maxDistanceSq = 0.0045 ** 2;
    for (const lineRef of lineRefs) {
      const feature = activeCity.lines.features.find((item) => String(item.properties.line_ref) === lineRef);
      if (!feature) continue;
      const geometry = currentGeometry(feature);
      for (const line of geometry.coordinates) {
        for (let index = 0; index < line.length - 1; index += 1) {
          if (pointSegmentDistanceSq(point, line[index], line[index + 1]) <= maxDistanceSq) return true;
        }
      }
    }
    return false;
  }

  function clearMetroLayers() {
    [...lineLayers.values()].forEach((set) => {
      set.halo.remove();
      set.color.remove();
    });
    [...lineLabels.values()].forEach((label) => label.remove());
    stationMarkers.forEach((marker) => marker.remove());
    stationLabels.forEach((label) => label.remove());
    lineLayers = new Map();
    lineLabels = new Map();
    stationMarkers = [];
    stationLabels = [];
    lineFilters.innerHTML = "";
    activeBounds = L.latLngBounds([]);
  }

  function renderMetroLayers(options = {}) {
    clearMetroLayers();
    setTileLayer();
    const city = activeCity;

    city.lines.features.forEach((feature) => {
      const displayFeature = featureForDisplay(feature);
      const properties = displayFeature.properties || {};
      const lineRef = String(properties.line_ref || "");
      const lineLabelText = displayLineRef(lineRef);
      const color = asColor(properties.colour, "#334155");
      const halo = L.geoJSON(displayFeature, {
        interactive: false,
        style: { color: "#fff", weight: 12, opacity: 0.94, lineCap: "round", lineJoin: "round" },
      });
      const colorLayer = L.geoJSON(displayFeature, {
        style: { color, weight: 7, opacity: 0.98, lineCap: "round", lineJoin: "round" },
      }).bindPopup(
        `<div class="popup-title">${city.name_en} Metro ${lineLabelText}</div>` +
          `<div class="popup-meta">${properties.way_count || ""} source segments</div>`,
      );
      if (linesVisible) {
        halo.addTo(map);
        colorLayer.addTo(map);
      }
      activeBounds.extend(colorLayer.getBounds());
      lineLayers.set(lineRef, { halo, color: colorLayer });

      const label = L.marker(midpointOfGeometry(displayFeature.geometry), {
        interactive: false,
        icon: L.divIcon({
          className: "line-label",
          html: `<span style="background:${color}">${lineLabelText}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      });
      if (linesVisible) label.addTo(map);
      lineLabels.set(lineRef, label);
    });

    city.stations.features.forEach((feature) => {
      const properties = feature.properties || {};
      const rawName = properties.name_en || properties.name || "";
      const isPlaceholderName = /^Stop \d+$/.test(rawName);
      const displayName = isPlaceholderName ? "" : rawName;
      const coords = currentGeometry(feature).coordinates;
      const latLng = [coords[1], coords[0]];
      const marker = L.marker(latLng, {
        title: displayName,
        icon: L.divIcon({ className: "station-marker", iconSize: [8, 8], iconAnchor: [4, 4] }),
      }).bindPopup(
        `<div class="popup-title">${displayName || "Station"}</div>` +
          `<div class="popup-meta">${city.name_en} · ${styleConfigs[styleSelect.value].name}</div>`,
      );
      marker.stationName = displayName;
      marker.stationPoint = coords;
      if (stationsVisible) marker.addTo(map);
      stationMarkers.push(marker);
      activeBounds.extend(latLng);

      const label = L.marker(latLng, {
        interactive: false,
        icon: L.divIcon({
          className: "station-label",
          html: displayName ? `<span>${displayName}</span>` : "",
          iconAnchor: [-8, 18],
        }),
      });
      label.stationPoint = coords;
      stationLabels.push(label);
    });

    renderLineFilters();
    updateStationLabels();
    if (options.fitBounds) {
      map.fitBounds(activeBounds.pad(0.08));
    }
  }

  function renderLineFilters() {
    [...lineLayers.keys()].forEach((lineRef) => {
      const feature = activeCity.lines.features.find((item) => String(item.properties.line_ref) === lineRef);
      const color = asColor(feature?.properties?.colour, "#334155");
      const label = document.createElement("label");
      label.className = "line-filter";
      label.innerHTML = `
        <input type="checkbox" value="${lineRef}" checked>
        <span class="swatch" style="background:${color}"></span>
        <span>${displayLineRef(lineRef)}</span>
      `;
      label.querySelector("input").addEventListener("change", updateLineAndStationVisibility);
      lineFilters.append(label);
    });
    updateLineAndStationVisibility();
  }

  function updateStationLabels() {
    if (!map) return;
    const selected = selectedLineRefs();
    const shouldShow = stationsVisible && labelsVisible && map.getZoom() >= stationLabelMinZoom;
    stationLabels.forEach((label) => {
      if (shouldShow && stationNearLine(label.stationPoint, selected)) label.addTo(map);
      else label.remove();
    });
  }

  function updateStationVisibility() {
    const selected = selectedLineRefs();
    stationMarkers.forEach((marker) => {
      if (stationsVisible && stationNearLine(marker.stationPoint, selected)) marker.addTo(map);
      else marker.remove();
    });
    updateStationLabels();
  }

  function updateLineAndStationVisibility() {
    const selected = selectedLineRefs();
    linesVisible = selected.size > 0;
    toggleLines.setAttribute("aria-pressed", String(linesVisible));
    lineLayers.forEach((layerSet, lineRef) => {
      const enabled = selected.has(lineRef);
      const lineLabel = lineLabels.get(lineRef);
      if (enabled) {
        layerSet.halo.addTo(map);
        layerSet.color.addTo(map);
        lineLabel.addTo(map);
      } else {
        layerSet.halo.remove();
        layerSet.color.remove();
        lineLabel.remove();
      }
    });
    updateStationVisibility();
  }

  function siteBasePath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (cityById.has(last)) {
      parts.pop();
    }
    return `/${parts.join("/")}${parts.length ? "/" : ""}`;
  }

  function openCity(cityId, updateUrl = false) {
    activeCity = cityById.get(cityId);
    if (!activeCity) return;
    if (updateUrl) {
      history.pushState({ cityId }, "", `${siteBasePath()}${cityId}/`);
    }
    homeView.hidden = true;
    mapView.hidden = false;
    cityTitle.textContent = activeCity.name_en;
    citySubtitle.textContent = `${activeCity.province_en} · ${activeCity.line_count} lines · ${activeCity.station_count} stations`;
    stationSearch.value = "";
    ensureMap();
    setTimeout(() => {
      map.invalidateSize();
      renderMetroLayers({ fitBounds: true });
    }, 0);
  }

  function goHome() {
    history.pushState({ cityId: null }, "", siteBasePath());
    mapView.hidden = true;
    homeView.hidden = false;
  }

  document.getElementById("back-home").addEventListener("click", goHome);
  document.getElementById("fit-map").addEventListener("click", () => map.fitBounds(activeBounds.pad(0.08)));
  collapseTopbar.addEventListener("click", () => {
    const collapsed = mapTopbar.classList.toggle("is-collapsed");
    collapseTopbar.textContent = collapsed ? "Tools" : "⌃";
    collapseTopbar.setAttribute("aria-expanded", String(!collapsed));
    setTimeout(() => map?.invalidateSize(), 160);
  });
  collapseLegend.addEventListener("click", () => {
    const collapsed = lineLegend.classList.toggle("is-collapsed");
    collapseLegend.textContent = collapsed ? "Lines" : "⌄";
    collapseLegend.setAttribute("aria-expanded", String(!collapsed));
    setTimeout(() => map?.invalidateSize(), 160);
  });
  styleSelect.addEventListener("change", () => renderMetroLayers());
  toggleStations.addEventListener("click", (event) => {
    stationsVisible = !stationsVisible;
    event.currentTarget.setAttribute("aria-pressed", String(stationsVisible));
    updateStationVisibility();
  });
  toggleLabels.addEventListener("click", (event) => {
    labelsVisible = !labelsVisible;
    event.currentTarget.setAttribute("aria-pressed", String(labelsVisible));
    updateStationLabels();
  });
  toggleLines.addEventListener("click", (event) => {
    const shouldSelectAll = selectedLineRefs().size === 0;
    lineFilters.querySelectorAll("input").forEach((input) => {
      input.checked = shouldSelectAll;
    });
    event.currentTarget.setAttribute("aria-pressed", String(shouldSelectAll));
    updateLineAndStationVisibility();
  });
  stationSearch.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (highlightedStation) {
      highlightedStation.getElement()?.classList.remove("highlight");
      highlightedStation = null;
    }
    if (!query) return;
    const match = stationMarkers.find((marker) => marker.stationName.toLowerCase().includes(query));
    if (!match) return;
    if (!stationsVisible) {
      stationsVisible = true;
      toggleStations.setAttribute("aria-pressed", "true");
      updateStationVisibility();
    }
    map.setView(match.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
    match.openPopup();
    highlightedStation = match;
    setTimeout(() => match.getElement()?.classList.add("highlight"), 180);
  });

  provinceFilter.addEventListener("change", renderCityCards);
  citySearch.addEventListener("input", renderCityCards);

  provinceOptions();
  renderCityCards();

  window.addEventListener("popstate", () => {
    const currentCityId = location.pathname
      .split("/")
      .filter(Boolean)
      .pop();
    if (cityById.has(currentCityId)) {
      openCity(currentCityId, false);
    } else {
      mapView.hidden = true;
      homeView.hidden = false;
    }
  });

  const pathCityId = location.pathname
    .split("/")
    .filter(Boolean)
    .pop();
  if (cityById.has(pathCityId)) {
    openCity(pathCityId);
  }
})();
