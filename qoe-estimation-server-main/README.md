# qoe-estimation-server

This is a Flask web server capable of downloading all video qualities from a given MPD, and also ready to obtain certain information about those videos, in order to obtain the ITU-P.1203 MOS value.

The web page will show a text field where the user will introduce the URL to the MPD of a video, and that video will automatically be reproduced in a Dash.js player, where the media session will be recorded.

Once the user finishes the visualization of the video, a MOS value will be computed automatically and shown in the display.