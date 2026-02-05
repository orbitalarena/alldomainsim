// Cesium Configuration - Online/Offline Mode Support
//
// Offline mode uses local Cesium + NaturalEarthII imagery (bundled with Cesium).
// Run setup_offline.sh first to download local assets.
//
// To enable offline mode:
//   1. Set OFFLINE_MODE = true below, OR
//   2. Add ?offline=true to any viewer URL

// ============================================================================
// OFFLINE MODE TOGGLE
// ============================================================================
// Set to true for offline operation (requires setup_offline.sh to be run first)
const OFFLINE_MODE = (function() {
    // Check URL param first
    const params = new URLSearchParams(window.location.search);
    if (params.has('offline')) {
        return params.get('offline') !== 'false';
    }
    // Default: false (online mode)
    return false;
})();

// ============================================================================
// CESIUM ION TOKEN (only used in online mode)
// ============================================================================
if (!OFFLINE_MODE) {
    Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI1ZTkyNzJlMS03MWViLTRhYjYtYTFhMS0yYmNmNDJiYzdiNzciLCJpZCI6MzgzMzc2LCJpYXQiOjE3NjkzOTkwNjB9.x_HLVVBQW_MLIbU9diwnDgXrw68jDnUGX9rNoDXzxfU';
}

// ============================================================================
// OFFLINE IMAGERY PROVIDER
// ============================================================================
// Uses NaturalEarthII tiles bundled with Cesium (~10km/pixel resolution)
// Good enough for orbital views and scenario placement
function getOfflineImageryProvider() {
    return Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    );
}

// ============================================================================
// TERRAIN SETUP
// ============================================================================
// In offline mode, uses flat ellipsoid (no terrain elevation)
// In online mode, attempts Cesium World Terrain
function setupTerrain(viewer) {
    if (OFFLINE_MODE) {
        // Flat ellipsoid - no network required
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        return Promise.resolve();
    } else {
        // Online: try Cesium Ion world terrain
        return Cesium.createWorldTerrainAsync().then(function(terrain) {
            viewer.terrainProvider = terrain;
        }).catch(function(e) {
            console.warn('World terrain unavailable:', e);
        });
    }
}

// ============================================================================
// IMAGERY SETUP
// ============================================================================
// Sets up the base imagery layer for a viewer
function setupImagery(viewer) {
    if (OFFLINE_MODE) {
        // Remove default layers and add NaturalEarthII
        viewer.imageryLayers.removeAll();
        getOfflineImageryProvider().then(function(provider) {
            viewer.imageryLayers.addImageryProvider(provider);
        }).catch(function(e) {
            console.warn('Failed to load offline imagery:', e);
        });
    }
    // Online mode uses Cesium's default Bing imagery (via Ion token)
}

// ============================================================================
// VIEWER OPTIONS HELPER
// ============================================================================
// Returns viewer constructor options appropriate for current mode
function getViewerOptions(overrides) {
    const baseOptions = {
        baseLayerPicker: !OFFLINE_MODE, // Disable in offline (all options need network)
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        vrButton: false,
        infoBox: false,
        selectionIndicator: false,
        shadows: false,
        shouldAnimate: true
    };

    // In offline mode, explicitly set imagery provider
    if (OFFLINE_MODE) {
        baseOptions.imageryProvider = false; // We'll set it manually after
    }

    return Object.assign({}, baseOptions, overrides || {});
}

// ============================================================================
// FULL VIEWER SETUP
// ============================================================================
// Creates and configures a viewer with appropriate offline/online settings
function createConfiguredViewer(containerId, options) {
    const mergedOptions = getViewerOptions(options);
    const viewer = new Cesium.Viewer(containerId, mergedOptions);

    // Setup terrain and imagery
    setupTerrain(viewer);
    setupImagery(viewer);

    // Add ArcGIS providers if online and baseLayerPicker is enabled
    if (!OFFLINE_MODE && mergedOptions.baseLayerPicker !== false) {
        if (typeof addArcGISProviders === 'function') {
            addArcGISProviders(viewer);
        }
    }

    return viewer;
}

// ============================================================================
// ARCGIS IMAGERY PROVIDERS (online mode only)
// ============================================================================
const additionalImageryProviders = OFFLINE_MODE ? [] : [
    new Cesium.ProviderViewModel({
        name: 'ArcGIS World Imagery',
        iconUrl: Cesium.buildModuleUrl('Widgets/Images/ImageryProviders/esriWorldImagery.png'),
        tooltip: 'ArcGIS World Imagery provides high-resolution satellite and aerial imagery.',
        creationFunction: function() {
            return new Cesium.ArcGisMapServerImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
            });
        }
    }),
    new Cesium.ProviderViewModel({
        name: 'ArcGIS World Street Map',
        iconUrl: Cesium.buildModuleUrl('Widgets/Images/ImageryProviders/esriWorldStreetMap.png'),
        tooltip: 'ArcGIS World Street Map',
        creationFunction: function() {
            return new Cesium.ArcGisMapServerImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer'
            });
        }
    }),
    new Cesium.ProviderViewModel({
        name: 'ArcGIS National Geographic',
        iconUrl: Cesium.buildModuleUrl('Widgets/Images/ImageryProviders/esriNationalGeographic.png'),
        tooltip: 'ArcGIS National Geographic World Map',
        creationFunction: function() {
            return new Cesium.ArcGisMapServerImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer'
            });
        }
    })
];

// Helper function to add ArcGIS providers to a viewer's baseLayerPicker
function addArcGISProviders(viewer) {
    if (OFFLINE_MODE) return; // No-op in offline mode
    if (viewer.baseLayerPicker) {
        const imageryProviders = viewer.baseLayerPicker.viewModel.imageryProviderViewModels;
        additionalImageryProviders.forEach(provider => {
            imageryProviders.push(provider);
        });
    }
}

// ============================================================================
// STATUS LOGGING
// ============================================================================
console.log('[CesiumConfig] Mode:', OFFLINE_MODE ? 'OFFLINE' : 'ONLINE');
if (OFFLINE_MODE) {
    console.log('[CesiumConfig] Using local Cesium + NaturalEarthII imagery');
    console.log('[CesiumConfig] Terrain: flat ellipsoid (no elevation)');
}
