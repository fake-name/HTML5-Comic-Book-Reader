#!/bin/bash

echo "Building"

make clean
make
cp -r ./comicbook/ ../MangaCMS/ctnt/staticContent/
