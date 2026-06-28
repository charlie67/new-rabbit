# New Rabbit

Like old rabbit but new. This only handles the remote browser, needs to be wrapped in an orchestration layer.

## To Run:
Just build the Docker container and run it that way.

docker build -t new-rabbit .
docker run --rm -p 3000:3000 -p 8189:8189/udp -p 8189:8189 new-rabbit

Then navigate to http://localhost:3000/

Port 3000 is used for the node web UI
Port 8189 is used for WebRTC media (UDP + TCP)

To reach it from another machine, set the host's LAN/public address instead:

docker run -p 3000:3000 -p 8189:8189/udp -p 8189:8189 -e MTX_WEBRTCADDITIONALHOSTS=<host-ip> new-rabbit

Very very WIP