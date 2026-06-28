# New Rabbit

Like old rabbit but new. This only handles the remote browser, needs to be wrapped in an orchestration layer.

## To Run:
Just build the Docker container and run it that way.

docker build -t new-rabbit .
docker run --rm -p 3000:3000 -p 8189:8189/udp -p 8189:8189 new-rabbit

Then navigate to http://localhost:3000/

Port 3000 is used for the node web UI
Port 8189 is used for WebRTC media (UDP + TCP)

MAKE SURE YOU USE CHROME!!! No I don't know why it won't work in firefox but it won't. 

Very very WIP
* Latency is bad (very very bad)
* No copy/paste
* Can only use 1 tab
* No shortcuts