import { THREE } from '../lib/libs';

/**
 * Viewport effects: shadows from a sun light, screen space ambient occlusion and cavity (ridges and valleys, like Blender).
 * They are rendered as a post process after the regular scene render, so they work with every material and view mode:
 * 1. The scene is rendered into a color target as usual (without the transform gizmo)
 * 2. The model is rendered into a normal + depth buffer, respecting texture transparency
 * 3. For shadows, the model's depth is rendered from the light into a shadow map
 * 4. Ambient occlusion is calculated from the depth and normal buffer, then blurred
 * 5. Everything is combined onto the canvas, and the transform gizmo is drawn on top
 */

const FULLSCREEN_VERTEX = `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const VIEW_POSITION_GLSL = `
uniform mat4 cameraProjectionInverse;
vec3 getViewPosition(vec2 uv, float depth) {
	vec4 view = cameraProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
	return view.xyz / view.w;
}`;

const PREPASS_VERTEX = `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vViewNormal;
varying vec2 vUv;
void main() {
	vUv = uv;
	vViewNormal = normalize(normalMatrix * normal);
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	#include <clipping_planes_vertex>
	gl_Position = projectionMatrix * mvPosition;
}`;

const PREPASS_FRAGMENT = `
#include <common>
#include <clipping_planes_pars_fragment>
uniform sampler2D map;
uniform bool USE_MAP;
varying vec3 vViewNormal;
varying vec2 vUv;
void main() {
	#include <clipping_planes_fragment>
	if (USE_MAP && texture2D(map, vUv).a < 0.01) discard;
	vec3 normal = normalize(vViewNormal);
	if (!gl_FrontFacing) normal = -normal;
	gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
}`;

const AO_FRAGMENT = `
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 cameraProjection;
uniform float radius;
varying vec2 vUv;
${VIEW_POSITION_GLSL}

const int SAMPLES = 16;

void main() {
	float depth = texture2D(tDepth, vUv).x;
	if (depth >= 1.0) {
		gl_FragColor = vec4(1.0);
		return;
	}
	vec3 position = getViewPosition(vUv, depth);
	vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);

	// Rotate the sample kernel in a 4x4 pattern, which the blur pass evens out
	vec2 tile = mod(floor(gl_FragCoord.xy), 4.0);
	float angle = (tile.x + tile.y * 4.0) / 16.0 * 6.2831853;
	vec3 random_vec = vec3(cos(angle), sin(angle), 0.0);
	vec3 tangent = random_vec - normal * dot(random_vec, normal);
	if (length(tangent) < 0.01) tangent = vec3(0.0, 0.0, 1.0) - normal * normal.z;
	tangent = normalize(tangent);
	mat3 tbn = mat3(tangent, cross(normal, tangent), normal);

	float bias = radius * 0.02;
	float occlusion = 0.0;
	for (int i = 0; i < SAMPLES; i++) {
		float fi = float(i);
		float z = (fi + 0.5) / float(SAMPLES);
		float r = sqrt(1.0 - z * z);
		float phi = fi * 2.3999632;
		float scale = fi / float(SAMPLES);
		scale = mix(0.1, 1.0, scale * scale);
		vec3 sample_position = position + tbn * vec3(cos(phi) * r, sin(phi) * r, z) * radius * scale;

		vec4 offset = cameraProjection * vec4(sample_position, 1.0);
		vec2 sample_uv = offset.xy / offset.w * 0.5 + 0.5;
		if (sample_uv.x < 0.0 || sample_uv.x > 1.0 || sample_uv.y < 0.0 || sample_uv.y > 1.0) continue;

		float sample_depth = texture2D(tDepth, sample_uv).x;
		if (sample_depth >= 1.0) continue;
		float scene_z = getViewPosition(sample_uv, sample_depth).z;
		float range_check = smoothstep(0.0, 1.0, radius / abs(position.z - scene_z));
		occlusion += (scene_z >= sample_position.z + bias ? 1.0 : 0.0) * range_check;
	}
	gl_FragColor = vec4(vec3(1.0 - occlusion / float(SAMPLES)), 1.0);
}`;

const BLUR_FRAGMENT = `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 resolution;
varying vec2 vUv;
${VIEW_POSITION_GLSL}

void main() {
	float depth = texture2D(tDepth, vUv).x;
	if (depth >= 1.0) {
		gl_FragColor = vec4(1.0);
		return;
	}
	float center_z = getViewPosition(vUv, depth).z;
	float sum = 0.0;
	float weight_sum = 0.0;
	for (int x = -2; x < 2; x++) {
		for (int y = -2; y < 2; y++) {
			vec2 uv = vUv + vec2(float(x), float(y)) / resolution;
			float sample_depth = texture2D(tDepth, uv).x;
			if (sample_depth >= 1.0) continue;
			float z = getViewPosition(uv, sample_depth).z;
			// Don't blur across depth edges
			float weight = 1.0 - smoothstep(0.0, 0.05 * abs(center_z), abs(z - center_z));
			sum += texture2D(tAO, uv).r * weight;
			weight_sum += weight;
		}
	}
	gl_FragColor = vec4(vec3(weight_sum > 0.0 ? sum / weight_sum : 1.0), 1.0);
}`;

const COMPOSITE_FRAGMENT = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tAO;
uniform sampler2D tShadow;

uniform bool AO_ON;
uniform bool CAVITY_ON;
uniform bool SHADOW_ON;
uniform bool SOFT_SHADOWS;
uniform bool GROUND_ON;

uniform vec2 resolution;
uniform mat4 cameraWorld;
uniform float aoStrength;
uniform float ridge;
uniform float valley;
uniform float cavityWidth;

uniform mat4 lightMatrix;
uniform vec3 lightDirection;
uniform float shadowStrength;
uniform float shadowSoftness;
uniform float shadowTexel;
uniform float shadowWorldTexel;
uniform float shadowRange;
uniform float groundY;

varying vec2 vUv;
${VIEW_POSITION_GLSL}

const vec2 POISSON[16] = vec2[](
	vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
	vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
	vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
	vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790)
);

float interleavedNoise(vec2 position) {
	return fract(52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715))));
}

float shadowVisibility(vec3 world_position) {
	vec4 light_position = lightMatrix * vec4(world_position, 1.0);
	vec3 coords = light_position.xyz / light_position.w * 0.5 + 0.5;
	if (coords.x < 0.0 || coords.x > 1.0 || coords.y < 0.0 || coords.y > 1.0 || coords.z > 1.0) return 1.0;
	float receiver = coords.z - 0.0005;

	if (!SOFT_SHADOWS) {
		float lit = 0.0;
		for (int x = -1; x <= 1; x++) {
			for (int y = -1; y <= 1; y++) {
				lit += step(receiver, texture2D(tShadow, coords.xy + vec2(float(x), float(y)) * shadowTexel).x);
			}
		}
		return lit / 9.0;
	}

	// Soft shadows: the penumbra grows with the distance between the shadow caster and the receiver
	float angle = interleavedNoise(gl_FragCoord.xy) * 6.2831853;
	mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
	float light_size = shadowSoftness * 0.15;

	float search_radius = clamp(light_size * 40.0, 2.0, 60.0) * shadowTexel;
	float blocker_sum = 0.0;
	float blockers = 0.0;
	for (int i = 0; i < 16; i++) {
		float depth = texture2D(tShadow, coords.xy + rotation * POISSON[i] * search_radius).x;
		if (depth < receiver) {
			blocker_sum += depth;
			blockers += 1.0;
		}
	}
	if (blockers == 0.0) return 1.0;
	float blocker_distance = (receiver - blocker_sum / blockers) * shadowRange;
	float filter_radius = clamp(blocker_distance * light_size / shadowWorldTexel, 1.0, 60.0) * shadowTexel;

	float lit = 0.0;
	for (int i = 0; i < 16; i++) {
		lit += step(receiver, texture2D(tShadow, coords.xy + rotation * POISSON[i] * filter_radius).x);
	}
	return lit / 16.0;
}

void main() {
	vec4 color = texture2D(tColor, vUv);
	float depth = texture2D(tDepth, vUv).x;
	float darken = 1.0;
	float brighten = 0.0;
	float shadow = 0.0;

	if (depth < 1.0) {
		vec3 position = getViewPosition(vUv, depth);
		vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);

		if (AO_ON) {
			darken *= clamp(mix(1.0, texture2D(tAO, vUv).r, aoStrength), 0.0, 1.0);
		}

		if (CAVITY_ON) {
			// Screen space curvature from the change of the normals across neighboring pixels
			vec2 step_x = vec2(cavityWidth / resolution.x, 0.0);
			vec2 step_y = vec2(0.0, cavityWidth / resolution.y);
			float edge_limit = 0.03 * abs(position.z) + cavityWidth * 0.5;
			vec3 normals[4];
			vec2 offsets[4];
			offsets[0] = step_x; offsets[1] = -step_x; offsets[2] = step_y; offsets[3] = -step_y;
			for (int i = 0; i < 4; i++) {
				float sample_depth = texture2D(tDepth, vUv + offsets[i]).x;
				// Ignore the background and objects in front or behind
				if (sample_depth >= 1.0 || abs(getViewPosition(vUv + offsets[i], sample_depth).z - position.z) > edge_limit) {
					normals[i] = normal;
				} else {
					normals[i] = normalize(texture2D(tNormal, vUv + offsets[i]).xyz * 2.0 - 1.0);
				}
			}
			float curvature = (normals[0].x - normals[1].x) + (normals[2].y - normals[3].y);
			curvature = clamp(curvature, -1.0, 1.0);
			brighten += max(curvature, 0.0) * ridge * 0.5;
			darken *= 1.0 - max(-curvature, 0.0) * valley * 0.5;
		}

		if (SHADOW_ON) {
			vec3 world_position = (cameraWorld * vec4(position, 1.0)).xyz;
			vec3 world_normal = normalize(mat3(cameraWorld) * normal);
			float facing = dot(world_normal, lightDirection);
			float visibility = facing > 0.0 ? shadowVisibility(world_position + world_normal * shadowWorldTexel * 1.5) : 0.0;
			visibility *= smoothstep(0.0, 0.25, facing);
			shadow = (1.0 - visibility) * shadowStrength;
		}

	} else if (SHADOW_ON && GROUND_ON) {
		// Shadow on the ground plane behind the model
		vec3 near = (cameraWorld * vec4(getViewPosition(vUv, 0.0), 1.0)).xyz;
		vec3 far = (cameraWorld * vec4(getViewPosition(vUv, 1.0), 1.0)).xyz;
		float t = (groundY - near.y) / (far.y - near.y);
		if (t > 0.0 && t < 1.0) {
			vec3 ground_position = mix(near, far, t);
			shadow = (1.0 - shadowVisibility(ground_position + vec3(0.0, shadowWorldTexel * 1.5, 0.0))) * shadowStrength * 0.75;
		}
	}

	vec3 rgb = color.rgb * darken + brighten * color.a;
	rgb *= 1.0 - shadow;
	// Shadows also darken a transparent background, which the canvas is composited on
	float alpha = 1.0 - (1.0 - color.a) * (1.0 - shadow);
	gl_FragColor = vec4(rgb, alpha);
}`;

type EffectTargets = {
	width: number
	height: number
	color: THREE.WebGLRenderTarget
	gbuffer: THREE.WebGLRenderTarget
	ao: THREE.WebGLRenderTarget
	ao_blur: THREE.WebGLRenderTarget
	shadow: THREE.WebGLRenderTarget
}

const SHADOW_MAP_SIZE = 2048;

const quad_camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;

function createPassMaterial(fragment_shader: string, uniforms: Record<string, any>) {
	let material = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: FULLSCREEN_VERTEX,
		fragmentShader: fragment_shader,
		depthTest: false,
		depthWrite: false,
		blending: THREE.NoBlending,
	});
	return material;
}

const ao_material = createPassMaterial(AO_FRAGMENT, {
	tDepth: {value: null},
	tNormal: {value: null},
	cameraProjection: {value: new THREE.Matrix4()},
	cameraProjectionInverse: {value: new THREE.Matrix4()},
	radius: {value: 6},
});
const blur_material = createPassMaterial(BLUR_FRAGMENT, {
	tAO: {value: null},
	tDepth: {value: null},
	resolution: {value: new THREE.Vector2()},
	cameraProjectionInverse: {value: new THREE.Matrix4()},
});
const composite_material = createPassMaterial(COMPOSITE_FRAGMENT, {
	tColor: {value: null},
	tDepth: {value: null},
	tNormal: {value: null},
	tAO: {value: null},
	tShadow: {value: null},
	AO_ON: {value: false},
	CAVITY_ON: {value: false},
	SHADOW_ON: {value: false},
	SOFT_SHADOWS: {value: false},
	GROUND_ON: {value: false},
	resolution: {value: new THREE.Vector2()},
	cameraProjectionInverse: {value: new THREE.Matrix4()},
	cameraWorld: {value: new THREE.Matrix4()},
	aoStrength: {value: 1},
	ridge: {value: 1},
	valley: {value: 1},
	cavityWidth: {value: 1},
	lightMatrix: {value: new THREE.Matrix4()},
	lightDirection: {value: new THREE.Vector3()},
	shadowStrength: {value: 0.6},
	shadowSoftness: {value: 0.4},
	shadowTexel: {value: 1 / SHADOW_MAP_SIZE},
	shadowWorldTexel: {value: 0.1},
	shadowRange: {value: 1},
	groundY: {value: 0},
});

// Materials used to render normals and depth, per original material, so texture transparency is respected
const prepass_materials = new WeakMap<THREE.Material, THREE.ShaderMaterial>();
const hidden_material = new THREE.MeshBasicMaterial({visible: false});
function getPrepassMaterial(material: THREE.Material): THREE.Material {
	if (!material || material.visible === false) return hidden_material;
	let prepass_material = prepass_materials.get(material);
	if (!prepass_material) {
		prepass_material = new THREE.ShaderMaterial({
			uniforms: {
				map: {value: null},
				USE_MAP: {value: false},
			},
			vertexShader: PREPASS_VERTEX,
			fragmentShader: PREPASS_FRAGMENT,
			clipping: true,
		});
		prepass_materials.set(material, prepass_material);
	}
	// @ts-ignore
	let map = material.uniforms?.map?.value ?? material.map ?? null;
	prepass_material.uniforms.map.value = map;
	prepass_material.uniforms.USE_MAP.value = !!map;
	prepass_material.side = material.side;
	prepass_material.clippingPlanes = material.clippingPlanes;
	return prepass_material;
}

/**
 * Temporarily swap the materials of all meshes for the prepass and hide everything else (outlines, vertex points, helpers)
 */
function prepareForPrepass(root: THREE.Object3D): () => void {
	let restore: (() => void)[] = [];
	root.traverse((object: any) => {
		if (object === root) return;
		if (object.isMesh) {
			let original = object.material;
			object.material = original instanceof Array ? original.map(getPrepassMaterial) : getPrepassMaterial(original);
			restore.push(() => object.material = original);
		} else if (object.visible && (object.isLine || object.isPoints || object.isSprite)) {
			object.visible = false;
			restore.push(() => object.visible = true);
		}
	});
	return () => restore.forEach(fn => fn());
}

function createTarget(width: number, height: number, options: THREE.WebGLRenderTargetOptions = {}): THREE.WebGLRenderTarget {
	return new THREE.WebGLRenderTarget(width, height, {
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		format: THREE.RGBAFormat,
		...options
	});
}
function createDepthTexture(renderer: THREE.WebGLRenderer, width: number, height: number) {
	let depth_texture = new THREE.DepthTexture(width, height);
	depth_texture.type = renderer.capabilities.isWebGL2 ? THREE.FloatType : THREE.UnsignedIntType;
	depth_texture.minFilter = depth_texture.magFilter = THREE.NearestFilter;
	return depth_texture;
}

const targets_per_preview = new WeakMap<Preview, EffectTargets>();
function getTargets(preview: Preview, width: number, height: number): EffectTargets {
	let targets = targets_per_preview.get(preview);
	if (targets && targets.width == width && targets.height == height) return targets;
	if (targets) {
		for (let key of ['color', 'gbuffer', 'ao', 'ao_blur', 'shadow']) {
			targets[key].depthTexture?.dispose();
			targets[key].dispose();
		}
	}
	let renderer = preview.renderer;
	let color: THREE.WebGLRenderTarget;
	if (renderer.capabilities.isWebGL2 && Settings.get('antialiasing')) {
		// @ts-ignore
		color = new THREE.WebGLMultisampleRenderTarget(width, height, {format: THREE.RGBAFormat});
		// @ts-ignore
		color.samples = 4;
	} else {
		color = createTarget(width, height, {minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter});
	}
	let gbuffer = createTarget(width, height);
	gbuffer.depthTexture = createDepthTexture(renderer, width, height);
	let shadow = createTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
	shadow.depthTexture = createDepthTexture(renderer, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

	targets = {
		width, height,
		color,
		gbuffer,
		ao: createTarget(width, height),
		ao_blur: createTarget(width, height),
		shadow,
	};
	targets_per_preview.set(preview, targets);
	return targets;
}

const light_camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bounding_box = new THREE.Box3();
const bounding_sphere = new THREE.Sphere();
const light_direction = new THREE.Vector3();
const drawing_buffer_size = new THREE.Vector2();
const clear_color = new THREE.Color();

/**
 * Fit the light's shadow camera around the model, including its shadow on the ground
 */
function updateLightCamera(root: THREE.Object3D, ground_y: number, include_ground: boolean): boolean {
	bounding_box.setFromObject(root);
	if (bounding_box.isEmpty()) return false;
	bounding_box.getBoundingSphere(bounding_sphere);
	let {center, radius} = bounding_sphere;
	radius = Math.max(radius, 1);

	let azimuth = Math.degToRad(settings.preview_light_direction.value as number);
	let elevation = Math.degToRad(settings.preview_light_height.value as number);
	light_direction.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)).normalize();

	let half_size = radius;
	if (include_ground) {
		let height_above_ground = Math.max(center.y + radius - ground_y, 0);
		half_size += Math.min(height_above_ground / Math.tan(Math.max(elevation, Math.degToRad(8))), radius * 6);
	}
	let distance = half_size + radius * 2;
	light_camera.left = -half_size;
	light_camera.right = half_size;
	light_camera.top = half_size;
	light_camera.bottom = -half_size;
	light_camera.near = 0;
	light_camera.far = distance * 2;
	light_camera.position.copy(center).addScaledVector(light_direction, distance);
	light_camera.up.set(0, 1, 0);
	if (Math.abs(light_direction.y) > 0.999) light_camera.up.set(0, 0, 1);
	light_camera.lookAt(center);
	light_camera.updateMatrixWorld();
	light_camera.updateProjectionMatrix();
	return true;
}

function renderQuad(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
	quad.material = material;
	renderer.setRenderTarget(target);
	renderer.render(quad, quad_camera);
}

export const ViewportEffects = {
	isActive(preview: Preview): boolean {
		if (!Project || !Project.model_3d || Modes.paint) return false;
		// The shaders use GLSL 3 features
		if (!preview.renderer || !preview.renderer.capabilities.isWebGL2) return false;
		return settings.preview_shadows.value != 'off' || !!settings.preview_ssao.value || !!settings.preview_cavity.value;
	},
	render(preview: Preview, renderScene: () => void, ground_y: number) {
		let renderer = preview.renderer;
		let camera = preview.camera;
		let root = Project.model_3d;
		renderer.getDrawingBufferSize(drawing_buffer_size);
		let width = Math.max(1, Math.floor(drawing_buffer_size.x));
		let height = Math.max(1, Math.floor(drawing_buffer_size.y));
		let targets = getTargets(preview, width, height);

		let shadows_on = settings.preview_shadows.value != 'off';
		let ao_on = !!settings.preview_ssao.value;
		let cavity_on = !!settings.preview_cavity.value;
		let ground_on = shadows_on && !!settings.preview_ground_shadow.value;

		let previous_target = renderer.getRenderTarget();
		let previous_auto_clear = renderer.autoClear;
		renderer.getClearColor(clear_color);
		let previous_clear_alpha = renderer.getClearAlpha();

		try {
			// 1. Regular scene, without the gizmo
			let transformer_visible = Transformer.visible;
			Transformer.visible = false;
			renderer.setRenderTarget(targets.color);
			renderScene();
			Transformer.visible = transformer_visible;

			// 2. Normals and depth, 3. shadow map
			let restore = prepareForPrepass(root);
			try {
				renderer.autoClear = true;
				renderer.setClearColor(0x8080ff, 1);
				renderer.setRenderTarget(targets.gbuffer);
				renderer.render(root, camera);

				if (shadows_on) {
					shadows_on = updateLightCamera(root, ground_y, ground_on);
					if (shadows_on) {
						renderer.setRenderTarget(targets.shadow);
						renderer.render(root, light_camera);
					}
				}
			} finally {
				restore();
				renderer.setClearColor(clear_color, previous_clear_alpha);
			}

			// 4. Ambient occlusion
			if (ao_on) {
				ao_material.uniforms.tDepth.value = targets.gbuffer.depthTexture;
				ao_material.uniforms.tNormal.value = targets.gbuffer.texture;
				ao_material.uniforms.cameraProjection.value.copy(camera.projectionMatrix);
				ao_material.uniforms.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
				ao_material.uniforms.radius.value = settings.preview_ssao_radius.value;
				renderQuad(renderer, ao_material, targets.ao);

				blur_material.uniforms.tAO.value = targets.ao.texture;
				blur_material.uniforms.tDepth.value = targets.gbuffer.depthTexture;
				blur_material.uniforms.resolution.value.set(width, height);
				blur_material.uniforms.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
				renderQuad(renderer, blur_material, targets.ao_blur);
			}

			// 5. Combine
			let uniforms = composite_material.uniforms;
			uniforms.tColor.value = targets.color.texture;
			uniforms.tDepth.value = targets.gbuffer.depthTexture;
			uniforms.tNormal.value = targets.gbuffer.texture;
			uniforms.tAO.value = targets.ao_blur.texture;
			uniforms.tShadow.value = targets.shadow.depthTexture;
			uniforms.AO_ON.value = ao_on;
			uniforms.CAVITY_ON.value = cavity_on;
			uniforms.SHADOW_ON.value = shadows_on;
			uniforms.SOFT_SHADOWS.value = settings.preview_shadows.value == 'soft';
			uniforms.GROUND_ON.value = ground_on;
			uniforms.resolution.value.set(width, height);
			uniforms.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
			uniforms.cameraWorld.value.copy(camera.matrixWorld);
			uniforms.aoStrength.value = (settings.preview_ssao_strength.value as number) / 100;
			uniforms.ridge.value = (settings.preview_cavity_ridge.value as number) / 100;
			uniforms.valley.value = (settings.preview_cavity_valley.value as number) / 100;
			uniforms.cavityWidth.value = Math.max(1, Math.round(window.devicePixelRatio));
			if (shadows_on) {
				uniforms.lightMatrix.value.multiplyMatrices(light_camera.projectionMatrix, light_camera.matrixWorldInverse);
				uniforms.lightDirection.value.copy(light_direction);
				uniforms.shadowStrength.value = (settings.preview_shadow_strength.value as number) / 100;
				uniforms.shadowSoftness.value = (settings.preview_shadow_softness.value as number) / 100;
				uniforms.shadowWorldTexel.value = (light_camera.right - light_camera.left) / SHADOW_MAP_SIZE;
				uniforms.shadowRange.value = light_camera.far - light_camera.near;
				uniforms.groundY.value = ground_y;
			}
			renderer.autoClear = true;
			renderQuad(renderer, composite_material, previous_target);

			// Gizmo on top
			if (Transformer.visible && Transformer.parent) {
				renderer.autoClear = false;
				renderer.clearDepth();
				renderer.render(Transformer, camera);
			}
		} finally {
			renderer.autoClear = previous_auto_clear;
			renderer.setRenderTarget(previous_target);
		}
	}
}
