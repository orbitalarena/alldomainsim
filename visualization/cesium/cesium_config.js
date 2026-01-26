// Cesium Ion Configuration
// This token provides access to Cesium World Terrain, Bing imagery, and other Ion assets
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI1ZTkyNzJlMS03MWViLTRhYjYtYTFhMS0yYmNmNDJiYzdiNzciLCJpZCI6MzgzMzc2LCJpYXQiOjE3NjkzOTkwNjB9.x_HLVVBQW_MLIbU9diwnDgXrw68jDnUGX9rNoDXzxfU';

// Additional imagery providers for baseLayerPicker
// These will be added to viewers after initialization
const additionalImageryProviders = [
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
    if (viewer.baseLayerPicker) {
        const imageryProviders = viewer.baseLayerPicker.viewModel.imageryProviderViewModels;
        additionalImageryProviders.forEach(provider => {
            imageryProviders.push(provider);
        });
    }
}
