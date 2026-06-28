# New Rabbit

Like old rabbit but new.

## To Run:
Just build the Docker container and run it that way.

docker build -t new-rabbit .
docker run -p 3000:3000 -p 8189:8189/udp new-rabbit

Port 3000 is used for the node web UI
Port 8989 is used for WebRTC media - this must be exposed directly from the connector 

Very very WIP