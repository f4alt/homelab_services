FROM alpine:3.20

RUN apk add --no-cache openssl iproute2

COPY generate-cert.sh /usr/local/bin/generate-cert
RUN chmod +x /usr/local/bin/generate-cert

CMD ["generate-cert"]
