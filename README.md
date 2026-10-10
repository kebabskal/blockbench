# Blockbench

## About this fork

This is a fork of [JannisX11/blockbench](https://github.com/JannisX11/blockbench) with changes aimed at modeling and animating for game engines like Godot. Everything below is added on top of upstream Blockbench.

### Viewport navigation and selection
- **Godot-style navigation:** middle mouse orbits (also on top of models), Shift + middle mouse pans, Ctrl + middle mouse zooms.
- **Fly camera:** hold right mouse and use WASD to move, Q/E to go down/up, Shift/Ctrl for faster/slower and scroll for the fly speed. A right click without moving still opens the context menu. After flying, the orbit target is placed back on the model.
- **Selection:** Shift + click adds to the selection, Ctrl + click selects the parent group, dragging on the background box-selects, Escape deselects everything.
- **F** focuses and zooms to fit the selection.
- **T** toggles the current tool between local and global space.
- **Pen input** (Windows Ink) works for viewport navigation.
- **No hover flicker while navigating:** hover highlights and helpers pause while the camera moves.
- **Clean view while navigating:** gizmos, grids, wireframes, outlines and element markers are hidden while the camera moves (can be turned off).
- **The camera and field of view are saved in the project file** and restored when it's opened.

### Viewport effects
All of these are in the Preview Options popover, work in every view mode and are off by default unless noted.
- **Shadows** from a sun light, hard or soft, with an optional ground shadow.
- **Ambient occlusion** and **cavity** (like Blender's).
- **Outlines** around silhouettes and, optionally, on sharp creases.
- **Rim light** for crisp silhouettes against a backlight.
- **Prototype grid:** shows elements without a texture with a calm checker grid instead of their marker colors, like the prototype textures used for blockouts in game engines. Color, tile size (16 units = 1 m at a 1/16 export scale) and checker contrast are adjustable. The new **Prototype**, **Prototype Light** and **Prototype Dark** marker colors always show the grid, in three lightnesses of the grid color (same hue and saturation) for contrast, and new elements get it by default (or random colors, set in the settings).
- **Selection and hover outlines:** selected and hovered elements get an outline instead of a tint (on by default), with a faint line where they're hidden behind other geometry.
- Effects also show in Paint mode (can be turned off).

### Modeling
- **Face Drag tool (Q)** for blockouts: drag a cube face to move the cube along the plane of that face, Alt-drag it to move the cube along the face normal, or Shift-drag it to push or pull the face and resize the cube. Near an edge a handle appears: drag it to rotate the cube around its center, about the axis the edge runs along, with the edge following the mouse on screen (Shift snaps to 22.5°). The face or edge under the cursor is highlighted, Ctrl snaps finer, Escape cancels, and grabbing an already selected cube drags the whole selection.
- **Shift-drag a move arrow** to move on the plane perpendicular to it.
- **Drag the selection with the resize tool** to scale it uniformly.
- **Pivots move along with elements**, so moved elements keep their pivot relative to their geometry.
- **Add Element** in a group's context menu, and an **Add Mesh shape submenu** (Cube, Plane, Cylinder, ...) that adds the shape directly.
- **Ctrl+G with one element selected** puts it into the new group.

### Outliner
- **Alt-click an eye to solo** that object or group. Alt-click it again to restore the previous visibility.
- **Hide Everything Except Selection (I)** also works in Animate mode.

### Painting and 2D editor
- **Select Face Pixels:** selects the texture pixels of the selected faces, so adjustments only affect those faces.
- **Selection outlines in Paint mode** can be toggled from the paint toolbar.
- **Scroll to zoom** in the 2D editor without holding Ctrl (Shift scrolls instead).

### Animation
- **Seamless loops:** looping animations in the generic format carry motion across the loop point, so bones don't stop there. Smooth and bezier curves wrap around, and a bone doesn't need keyframes at the start and end.
- **Arrow keys move keyframes around the loop:** keyframes pushed past the end come back in at the start, which makes delaying a bone by a few frames easy.
- **Better IK:**
  - The whole chain bends on one consistent hinge, so the shin no longer twists differently from the thigh.
  - **IK Pole Angle** rotates the bend plane, and **IK Hinge Axis** picks the axis the chain bends around. The front of the chain faces the pole.
  - **IK Weight** is a keyframe channel on the null object (0 to 1) that blends between IK and the keyframed (FK) pose.
  - IK settings can be edited in the Element panel in Animate mode.
  - Exports and Bake IK Animation match the preview, including the blend with keyframed rotations.

### Interface
- **Menus run the entry the mouse is released over**, like native menus, so press-drag-release and right-button release work.
- **Docked panels show on their own** while the panel they're docked to is hidden, for example in a mode it doesn't support.


## About Blockbench

Blockbench is a free and open source model editor for low-poly models with pixel art textures.
Models can be exported into standardized formats, to be shared, rendered, 3D-printed, or used in game engines. There are also multiple dedicated formats for Minecraft Java and Bedrock Edition with format-specific features. 

Blockbench features a modern and beginner friendly interface, but also offers lots of customization and advanced features for experienced 3D artists. Plugins can extend the functionality of the program even further.

Website and download: [blockbench.net](https://www.blockbench.net)


![Interface](https://web.blockbench.net/content/front_page_app.png)



## Contribution

[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.0-4baaaa.svg)](CODE_OF_CONDUCT.MD)

Check out the [Contribution Guidelines](CONTRIBUTING.md).



## Launching Blockbench

To launch Blockbench from source, you can clone the repository, navigate to the correct branch and launch the program in development mode using the instructions below.
If you just want to use the latest version, please download the app from the website.

### Setup Repository
* Install [NodeJS](https://nodejs.org/en/).
* Then install all dependencies via
`npm install`


### Run in Electron
Use this command or press Ctrl + Shift + B to launch Blockbench in Electron:

`npm run dev`

To enable debugging in VS Code, switch to the **Run & Debug** tab, select the **"Debug Renderer"** configuration, and press the green arrow button to launch.
Now you can set breakpoints and debug inside VSCode.


### Run the web app
Use this command to launch the web app locally:

`npm run serve`

Now you can open the web app in your browser under http://localhost:3000


## Plugins

Blockbench supports Javascript-based plugins. Learn more about creating plugins on [https://www.blockbench.net/wiki/docs/plugin](https://www.blockbench.net/wiki/docs/plugin).



## License

* The Blockbench source-code is licensed under the GPL license version 3. See `LICENSE.MD`.
* Modifications to the source code can be made under the terms of that license.
* Blockbench plugins (external scripts) and themes (theme files to customize the design) that interact with the Blockbench API are an exception. Plugins and themes can be created and/or published as open source, proprietary or paid software.
* All assets created with Blockbench (models, textures, animations, screenshots etc.) are your own!
