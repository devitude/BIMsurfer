import Executor from './executor.js'
import GpuBufferManager from './gpubuffermanager.js'
import GeometryLoader from "./geometryloader.js"

export default class TileLoader {
	constructor(tilingRenderLayer, viewer, bimServerApi, densityThreshold, reuseLowerThreshold, geometryDataToReuse, roids, fieldsToInclude) {
		this.tilingRenderLayer = tilingRenderLayer;
		this.viewer = viewer;
		this.settings = viewer.settings;
		this.bimServerApi = bimServerApi;
		this.densityThreshold = densityThreshold;
		this.reuseLowerThreshold = reuseLowerThreshold;
		this.geometryDataToReuse = geometryDataToReuse;
		this.roids = roids;
		this.fieldsToInclude = fieldsToInclude;
	
		this.excludedTypes = ["IfcSpace", "IfcOpeningElement", "IfcAnnotation"];
		this.executor = new Executor(64);
		
//		if (this.viewer.vertexQuantization) {
//			this.quantizationMap = {};
//			for (var roid of this.roids) {
//				this.quantizationMap[roid] = this.viewer.vertexQuantization.getUntransformedVertexQuantizationMatrixForRoid(roid);
//			}
//		}
		
		this.loaderCounter = 0;
	}
	
	initialize() {
		var promise = new Promise((resolve, reject) => {
			this.bimServerApi.call("ServiceInterface", "getTileCounts", {
				roids: this.roids,
				excludedTypes: this.excludedTypes,
				geometryIdsToReuse: this.geometryDataToReuse,
				minimumThreshold: this.densityThreshold,
				maximumThreshold: -1,
				depth: this.settings.maxOctreeDepth
			}, (list) => {
				for (var i=0; i<list.length; i+=2) {
					var tileId = list[i];
					var nrObjects = list[i + 1];
					if (nrObjects == 0) {
						// Should not happen
						debugger;
						this.viewer.stats.inc("Tiling", "Empty");
						continue;
					}
					this.viewer.stats.inc("Tiling", "Full");
					var node = this.tilingRenderLayer.octree.getNodeById(tileId);
					
					node.loadingStatus = 0;
					node.nrObjects = nrObjects;
					node.stats = {
						triangles: 0,
						drawCallsPerFrame: 0
					};
				}
				resolve();
			});
		});
		return promise;
	}
	
	loadTile(node, executor) {
		if (!this.tilingRenderLayer.enabled) {
			return;
		}
		if (node.loadingStatus != 0) {
			return;
		}
		node.loadingStatus = 1;
		if (executor == null) {
			executor = this.executor;
		}
		if (node.nrObjects == 0) {
			node.loadingStatus = 2;
			// This happens for parent nodes that don't contain any objects, but have children that do have objects
			return;
		}
		
		node.gpuBufferManager = new GpuBufferManager(this.viewer);
		
		var bounds = node.getBounds();
		var query = {
			type: {
				name: "IfcProduct",
				includeAllSubTypes: true,
				exclude: this.excludedTypes
			},
			tiles: {
				ids: [node.id],
				densityUpperThreshold: this.densityThreshold,
				densityLowerThreshold: -1,
				reuseLowerThreshold: this.reuseLowerThreshold,
				geometryDataToReuse: Array.from(this.geometryDataToReuse),
				maxDepth: this.settings.maxOctreeDepth
			},
			include: {
				type: "IfcProduct",
				field: "geometry",
				include: {
					type: "GeometryInfo",
					field: "data",
					include: {
						type: "GeometryData",
						fieldsDirect: this.fieldsToInclude
					}
				}
			},
			loaderSettings: JSON.parse(JSON.stringify(this.settings.loaderSettings))
		};
		
		var geometryLoader = new GeometryLoader(this.loaderCounter++, this.bimServerApi, this.tilingRenderLayer, this.roids, this.settings.loaderSettings, this.quantizationMap, this.viewer.stats, this.settings, query, this.tilingRenderLayer.reusedGeometryCache);
		this.tilingRenderLayer.registerLoader(geometryLoader.loaderId);
		this.tilingRenderLayer.loaderToNode[geometryLoader.loaderId] = node;
		geometryLoader.onStart = () => {
			node.loadingStatus = 2;
			this.viewer.stats.inc("Tiling", "Loading");
			this.viewer.dirty = true;
		};
		executor.add(geometryLoader).then(() => {
			this.viewer.stats.dec("Tiling", "Loading");
			this.viewer.stats.inc("Tiling", "Loaded");
			if (node.gpuBufferManager.isEmpty() && 
					(node.bufferManager == null || node.bufferManager.bufferSets.size == 0)) {
				node.loadingStatus = 5;
			} else {
				node.loadingStatus = 3;
			}
			this.tilingRenderLayer.done(geometryLoader.loaderId);
		});
	}
	
	geometryLoaderDone(geometryLoader) {
		
	}
	
	loadAll(progressListener) {
		var executor = new Executor(64);
		executor.setProgressListener(progressListener);
			
			// TODO load per level, so first level 0, then 1 etc... These calls should be submitted to the executor only after the previous layer has been submitted
			// Maybe we could load 2 levels at a time, to improve performance... So 0 and 1, as soon as 0 has loaded, start loading 2 etc...
			
			// Traversing breath-first so the big chucks are loaded first
//			for (var l=0; l<=this.octree.deepestLevel; l++) {
//				
//			}
			
		this.tilingRenderLayer.octree.traverseBreathFirst((node) => {
			this.loadTile(node, executor);
		});
	
		executor.awaitTermination().then(() => {
			this.tilingRenderLayer.completelyDone();
//			this.tilingRenderLayer.octree.prepareBreathFirst((node) => {
//				return true;
//			});
			this.viewer.stats.requestUpdate();
			document.getElementById("progress").style.display = "none";
		});	
		return executor.awaitTermination();
	}
}